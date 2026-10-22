import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { parseFeedPackets } from "@/lib/market/feed";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import { marketDataEnabled } from "@/lib/security/flags";
import { requireUser } from "@/server/auth";
import { query } from "@/server/http";
import { configuredProvider, getDhanAccessToken, getDhanClientId } from "@/server/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Target = { symbol: string; segment: "NSE_FNO" | "BSE_FNO"; securityId: string };

/**
 * Server-sent events with live option trades for the user's open paper positions.
 * One Dhan WebSocket carries every requested contract (Dhan's REST quote API allows only ~1 call/second,
 * which other screens already use). Each connection lives under 60 seconds; the browser reconnects.
 */
export const GET = query(async (request) => {
  await requireUser();
  if (!marketDataEnabled() || configuredProvider() !== "dhan") throw new AppError("Live prices are not configured.", 503, "MARKET_DATA_DISABLED");
  const symbols = [...new Set(new URL(request.url).searchParams.getAll("s"))].filter((symbol) => parseOptionLedgerSymbol(symbol)).slice(0, 25);
  if (symbols.length === 0) throw new AppError("Choose at least one option contract.", 400);
  const rows = await prisma.instrument.findMany({ where: { symbol: { in: symbols } }, select: { symbol: true, dhanSecurityId: true } });
  const targets: Target[] = rows.flatMap((row) => {
    const contract = parseOptionLedgerSymbol(row.symbol);
    if (!contract || !/^\d{1,12}$/.test(row.dhanSecurityId)) return [];
    return [{ symbol: row.symbol, segment: contract.underlying === "SENSEX" || contract.underlying === "BANKEX" ? "BSE_FNO" as const : "NSE_FNO" as const, securityId: row.dhanSecurityId }];
  });
  if (targets.length === 0) throw new AppError("These contracts have no market identifier.", 404);
  return new Response(openFeed(request, targets), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
});

function openFeed(request: Request, targets: Target[]) {
  const encoder = new TextEncoder();
  const bySecurity = new Map(targets.map((target) => [target.securityId, target.symbol]));
  const list = targets.map((target) => ({ ExchangeSegment: target.segment, SecurityId: target.securityId }));
  let socket: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stop = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    try {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ RequestCode: 18, InstrumentCount: list.length, InstrumentList: list }));
        socket.send(JSON.stringify({ RequestCode: 12 }));
      }
    } catch { /* already closed */ }
    try { socket?.close(); } catch { /* already closed */ }
    socket = null;
  };

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { stop(); }
      };
      const finish = () => {
        stop();
        try { controller.close(); } catch { /* client already left */ }
      };
      try {
        if (typeof WebSocket === "undefined") {
          send("problem", { message: "This server cannot open a market-feed connection.", retry: false });
          finish();
          return;
        }
        const [token, clientId] = await Promise.all([getDhanAccessToken(), getDhanClientId()]);
        if (!clientId || request.signal.aborted) {
          finish();
          return;
        }
        socket = new WebSocket(`wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}&authType=2`);
        socket.binaryType = "arraybuffer";
        ping = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { finish(); } }, 15000);
        const lifetime = setTimeout(finish, 50000);
        request.signal.addEventListener("abort", () => { clearTimeout(lifetime); finish(); });
        socket.onopen = () => {
          // Quote mode (17) sends the last trade on subscribe, so a price appears even in a quiet market.
          socket?.send(JSON.stringify({ RequestCode: 17, InstrumentCount: list.length, InstrumentList: list }));
          send("status", { state: "subscribed", count: list.length });
        };
        socket.onmessage = async (event) => {
          const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : typeof Blob !== "undefined" && event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : null;
          if (!bytes) return;
          for (const packet of parseFeedPackets(bytes)) {
            if (packet.kind === "disconnect") {
              send("problem", { message: packet.message, retry: packet.retry });
              clearTimeout(lifetime);
              finish();
              return;
            }
            const symbol = bySecurity.get(String(packet.securityId));
            if (symbol) send("tick", { symbol, price: packet.price, time: packet.time });
          }
        };
        socket.onerror = () => send("problem", { message: "The market feed connection failed.", retry: true });
        socket.onclose = () => { clearTimeout(lifetime); finish(); };
      } catch {
        send("problem", { message: "The market feed is unavailable.", retry: true });
        finish();
      }
    },
    cancel() {
      stop();
    },
  });
}
