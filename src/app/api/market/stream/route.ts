import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { findIndex } from "@/lib/market/indices";
import { parseFeedPackets } from "@/lib/market/feed";
import { requireUser } from "@/server/auth";
import { feedTarget } from "@/server/dhan-market";
import { query } from "@/server/http";
import { configuredProvider, getDhanAccessToken, getDhanClientId } from "@/server/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = query(async (request) => {
  await requireUser();
  if (configuredProvider() !== "dhan") throw new AppError("Live prices are not configured.", 503);
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  if (!symbol) throw new AppError("Choose an instrument.", 400);
  const index = findIndex(symbol);
  const instrument = index ? null : await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument && !index) throw new AppError("Instrument is not available.", 404);
  const target = feedTarget(index?.symbol ?? symbol, instrument?.dhanSecurityId ?? "");
  return new Response(openFeed(request, target), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

function openFeed(request: Request, target: { securityId: string; segment: "IDX_I" | "NSE_EQ" }) {
  const encoder = new TextEncoder();
  let socket: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stop = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    release(socket, target);
    socket = null;
  };

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const finish = () => {
        stop();
        try { controller.close(); } catch { /* The client already left. */ }
      };
      try {
        if (typeof WebSocket === "undefined") {
          send("problem", { message: "This server cannot open a market-feed connection.", retry: false });
          finish();
          return;
        }
        const [token, clientId] = await Promise.all([getDhanAccessToken(), getDhanClientId()]);
        if (request.signal.aborted) {
          finish();
          return;
        }
        if (!clientId) {
          send("problem", { message: "The market-data client id is not set.", retry: false });
          finish();
          return;
        }
        const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        ping = setInterval(() => {
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { finish(); }
        }, 15000);
        const lifetime = setTimeout(finish, 50000);
        request.signal.addEventListener("abort", () => {
          clearTimeout(lifetime);
          finish();
        });
        socket.onopen = () => {
          socket?.send(JSON.stringify({
            RequestCode: 17,
            InstrumentCount: 1,
            InstrumentList: [{ ExchangeSegment: target.segment, SecurityId: target.securityId }],
          }));
          send("status", { state: "subscribed", securityId: target.securityId, segment: target.segment });
        };
        socket.onmessage = async (event) => {
          const bytes = await packetBytes(event.data);
          if (!bytes) return;
          for (const packet of parseFeedPackets(bytes)) {
            if (packet.kind === "disconnect") {
              send("problem", { message: packet.message, retry: packet.retry });
              clearTimeout(lifetime);
              finish();
              return;
            }
            if (String(packet.securityId) !== target.securityId) continue;
            send("tick", { price: packet.price, time: packet.time, dayVolume: packet.dayVolume });
          }
        };
        socket.onerror = () => send("problem", { message: "The market feed connection failed.", retry: true });
        socket.onclose = () => {
          clearTimeout(lifetime);
          finish();
        };
      } catch (error) {
        send("problem", { message: safeMessage(error), retry: true });
        finish();
      }
    },
    cancel() {
      stop();
    },
  });
}

function release(socket: WebSocket | null, target: { securityId: string; segment: string }) {
  if (!socket) return;
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        RequestCode: 18,
        InstrumentCount: 1,
        InstrumentList: [{ ExchangeSegment: target.segment, SecurityId: target.securityId }],
      }));
      socket.send(JSON.stringify({ RequestCode: 12 }));
    }
  } catch { /* The socket is already closed. */ }
  try { socket.close(); } catch { /* The socket is already closed. */ }
}

async function packetBytes(data: unknown) {
  if (typeof data === "string") return null;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "The market feed is unavailable.";
  if (/wss:|token=/i.test(message)) return "The market feed is unavailable.";
  return message;
}
