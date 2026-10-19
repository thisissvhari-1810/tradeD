"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Info, RefreshCw, X } from "lucide-react";
import { api, ApiError, istTime } from "@/components/api";
import { useDesk } from "@/components/shell";
import { Badge, Button, cx, SegmentedControl, Stepper } from "@/components/ui";

const RETRYABLE = new Set(["LEDGER_BUSY", "DATABASE_UNAVAILABLE", "QUOTE_UNAVAILABLE", "QUOTE_RATE_LIMITED", "NETWORK", "INTERNAL", "UNKNOWN", "PRICE_MOVED"]);
const MAX_LOTS = 50;
const LOT_CHIPS = [1, 5, 10, 20];
const STALE_MS = 60_000;

export type OptionOrderDraft = {
  underlying: string;
  name: string;
  expiry: string;
  strike: number;
  right: "CE" | "PE";
  action: "BUY" | "SELL";
  ltp: number | null;
  previousClose?: number | null;
  asOf: string | null;
  lotSize: number | null;
  heldLots: number | null;
  /** Average entry premium of the held lots, used to estimate realized P&L on a sell. */
  avgCost?: number | null;
  /** Set when the order is priced from the replay clock instead of the live chain. */
  replay: ReplayContext | null;
};

export type ReplayContext = { session: string; date: string };

export type ReplayQuote = {
  available: boolean;
  message: string;
  reason: string;
  date: string;
  cursor: number;
  premium: number | null;
  candleTime: number | null;
  candleEnd: number | null;
  ageSeconds: number | null;
  stale: boolean;
  sessionOpenPremium: number | null;
  coverage: { status: "complete" | "partial" | "unavailable"; minutes: number; expected: number };
  lotSize: number | null;
  policyLabel: string;
};

export const HISTORICAL_UNAVAILABLE = "Historical premium data is unavailable for this contract and time. Choose another contract or replay session.";

export function draftKey(draft: OptionOrderDraft) {
  return `${draft.underlying}|${draft.expiry}|${draft.strike}|${draft.right}|${draft.action}|${draft.replay?.session ?? draft.asOf ?? ""}`;
}

/** Realized P&L on a sell before charges: (exit − average entry) × quantity. */
export function exitEstimate(premium: number | null, avgCost: number | null | undefined, quantity: number | null) {
  if (premium == null || avgCost == null || !Number.isFinite(avgCost) || quantity == null) return null;
  return Math.round((premium - avgCost) * quantity * 100) / 100;
}

/** Premium totals shown before confirming. Simulated charges are added by the server at fill. */
export function ticketMath(input: { action: "BUY" | "SELL"; lots: string; lotSize: number | null; heldLots: number; premium: number | null; buyingPower: number | null }) {
  const maxLots = input.action === "BUY" ? MAX_LOTS : Math.min(MAX_LOTS, input.heldLots);
  const parsed = Number(input.lots);
  const validLots = input.lots !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= maxLots;
  const quantity = input.lotSize && validLots ? parsed * input.lotSize : null;
  const total = input.premium != null && quantity != null ? Math.round(input.premium * quantity * 100) / 100 : null;
  const after = input.buyingPower == null || total == null ? null : input.action === "BUY" ? input.buyingPower - total : input.buyingPower + total;
  return { maxLots, parsed, validLots, quantity, total, after, short: input.action === "BUY" && after != null && after < 0 };
}

type ChainSnapshot = { asOf: string; strikes: Array<{ strike: number; ce: { ltp: number | null; previousClose: number | null } | null; pe: { ltp: number | null; previousClose: number | null } | null }> };

/**
 * Right-docked ticket on large screens, slide-over on tablets, bottom sheet on phones.
 * Remount with key={draftKey(draft)} for a new contract so every field starts fresh.
 */
export function OptionOrderTicket({ draft, replayCursor = null, onClose, onFilled }: { draft: OptionOrderDraft; replayCursor?: number | null; onClose: () => void; onFilled: () => void }) {
  const desk = useDesk();
  const held = draft.heldLots ?? 0;
  const replay = draft.replay;
  const [action, setAction] = useState(draft.action);
  const [lots, setLots] = useState(draft.action === "SELL" && held ? String(held) : "1");
  const [livePremium, setPremium] = useState<number | null>(!replay && draft.ltp != null && draft.ltp > 0 ? draft.ltp : null);
  const [historical, setHistorical] = useState<{ key: string; quote: ReplayQuote | null; error: string } | null>(null);
  const cursorRef = useRef(replayCursor);
  useEffect(() => {
    cursorRef.current = replayCursor;
  });
  // A completed one-minute candle is the smallest step that can change the replay premium.
  const quoteKey = replay && replayCursor != null ? `${replay.session}|${Math.floor(replayCursor / 60)}` : null;

  useEffect(() => {
    const cursor = cursorRef.current;
    if (!replay || !quoteKey || cursor == null) return;
    let stop = false;
    api<ReplayQuote>("/api/demo/option-replay", { action: "quote", symbol: draft.underlying, expiry: draft.expiry, strike: draft.strike, right: draft.right, session: replay.session, cursor })
      .then((quote) => { if (!stop) setHistorical({ key: quoteKey, quote, error: "" }); })
      .catch((reason: unknown) => { if (!stop) setHistorical({ key: quoteKey, quote: null, error: reason instanceof Error ? reason.message : "The replay premium could not be loaded." }); });
    return () => { stop = true; };
  }, [quoteKey, replay, draft.underlying, draft.expiry, draft.strike, draft.right]);

  const replayQuote = historical?.quote ?? null;
  const replayLoading = Boolean(replay) && historical?.key !== quoteKey;
  const replayReady = Boolean(replay && replayQuote?.available && replayQuote.premium != null);
  const premium = replay ? (replayReady ? replayQuote!.premium : null) : livePremium;
  const lotSize = draft.lotSize ?? replayQuote?.lotSize ?? null;
  const [previous, setPrevious] = useState<number | null>(draft.previousClose ?? null);
  const [asOf, setAsOf] = useState(draft.asOf);
  const [buyingPower, setBuyingPower] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [retryable, setRetryable] = useState(false);
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    let stop = false;
    api<{ cashAvailable: string }>("/api/portfolio")
      .then((data) => { if (!stop) setBuyingPower(rupees(data.cashAvailable)); })
      .catch(() => { if (!stop) setBuyingPower(null); });
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => { stop = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const buy = action === "BUY";
  const { maxLots, parsed, validLots, quantity, total, after, short } = ticketMath({ action, lots, lotSize, heldLots: held, premium, buyingPower });
  const ageMs = !replay && asOf ? now - new Date(asOf).getTime() : null;
  const stale = ageMs != null && ageMs > STALE_MS;
  const reference = replay ? replayQuote?.sessionOpenPremium ?? null : previous;
  const change = premium != null && reference ? premium - reference : null;
  const changePct = change != null && reference ? (change / reference) * 100 : null;
  const label = `${draft.underlying} ${draft.strike} ${draft.right}`;
  const estimate = buy ? null : exitEstimate(premium, draft.avgCost, quantity);
  const blocked = busy || premium == null || !lotSize || !validLots || short || (!buy && held < 1) || (Boolean(replay) && !replayReady);

  function chooseAction(next: "BUY" | "SELL") {
    if (next === action) return;
    setAction(next);
    setLots(next === "SELL" && held ? String(held) : "1");
    setError("");
    key.current = crypto.randomUUID();
  }

  async function refreshPrice() {
    setRefreshing(true);
    try {
      const chain = await api<ChainSnapshot>(`/api/options/chain?symbol=${encodeURIComponent(draft.underlying)}&expiry=${encodeURIComponent(draft.expiry)}`);
      const row = chain.strikes.find((item) => item.strike === draft.strike);
      const side = draft.right === "CE" ? row?.ce : row?.pe;
      if (side?.ltp == null || side.ltp <= 0) throw new Error("This contract has no premium in the latest snapshot.");
      setPremium(side.ltp);
      setPrevious(side.previousClose ?? null);
      setAsOf(chain.asOf);
      setNow(Date.now());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The latest premium could not be loaded.");
      setRetryable(false);
    } finally {
      setRefreshing(false);
    }
  }

  async function submit() {
    if (blocked || !lotSize || premium == null) return;
    setBusy(true);
    setError("");
    setRetryable(false);
    try {
      const contract = { symbol: draft.underlying, expiry: draft.expiry, strike: draft.strike, right: draft.right, lots: parsed, idempotencyKey: key.current, referencePremium: premium };
      const saved = replay && replayQuote
        ? await api<{ id: string; status: string; quantity: number; averageFill: string | null; replayed: boolean }>("/api/demo/option-replay", { action: "order", side: action, session: replay.session, cursor: replayQuote.cursor, ...contract })
        : await api<{ id: string; status: string; quantity: number; averageFill: string | null; replayed: boolean }>("/api/demo/option", { action, ...contract });
      const when = replay && replayQuote ? ` at replay ${clockOf(replayQuote.cursor)} IST` : "";
      desk.toast(saved.replayed ? `${label}: this order was already placed.` : `${buy ? "Bought" : "Sold"} ${saved.quantity} ${label} at ₹${saved.averageFill ?? "—"}${when} (demo).`, { tone: "success" });
      onFilled();
      onClose();
    } catch (reason) {
      const code = reason instanceof ApiError ? reason.code : "UNKNOWN";
      if (code === "PRICE_MOVED" && reason instanceof ApiError && typeof reason.details?.latestPremium === "number") {
        setPremium(reason.details.latestPremium);
        if (typeof reason.details.asOf === "string") setAsOf(reason.details.asOf);
      }
      setError(reason instanceof Error ? reason.message : "The order was not placed.");
      setRetryable(RETRYABLE.has(code));
    } finally {
      setBusy(false);
    }
  }

  const cta = busy
    ? "Placing order…"
    : error && retryable
      ? "Retry"
      : `${buy ? "Buy" : "Sell"} ${validLots ? parsed : "—"} lot${parsed === 1 ? "" : "s"}${total != null ? ` · ${inr(total, 0)}` : ""}`;

  return (
    <section
      role="dialog"
      aria-label={`Order ticket ${label}`}
      className={cx(
        "anim-panel fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-sheet border-t border-border bg-overlay text-text shadow-e3",
        "sm:inset-x-auto sm:right-0 sm:top-[var(--topbar)] sm:max-h-none sm:w-[380px] sm:rounded-none sm:border-l sm:border-t-0",
        "lg:static lg:z-auto lg:h-full lg:shrink-0 lg:bg-panel lg:shadow-none",
      )}
    >
      <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong sm:hidden" aria-hidden />
      <header className="border-b border-border px-4 pb-4 pt-3">
        <div className="flex items-start gap-2">
          <h2 className="num min-w-0 flex-1 truncate text-[22px] font-semibold leading-tight tracking-tight">{draft.underlying} {draft.strike} {draft.right}</h2>
          {replay ? <Badge tone="info" title="Priced from historical data at the replay clock">Historical replay</Badge> : <Badge tone="demo">Demo</Badge>}
          <button type="button" aria-label="Close order ticket" className="-mr-1 grid h-8 w-8 place-items-center rounded-input text-muted hover:bg-elevated hover:text-text" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip>{draft.right === "CE" ? "Call" : "Put"}</Chip>
          <Chip>Exp {shortDate(draft.expiry)}</Chip>
          <Chip>Lot {lotSize ?? "N/A"}</Chip>
          {held > 0 ? <Chip>Holding {held} lot{held === 1 ? "" : "s"}</Chip> : null}
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="num text-[28px] font-semibold leading-none">{premium == null ? "—" : inr(premium)}</span>
          {change != null && changePct != null ? (
            <span className={cx("num text-[13px] font-medium", change > 0 ? "text-profit" : change < 0 ? "text-loss" : "text-muted")}>
              {change > 0 ? "▲ +" : change < 0 ? "▼ −" : ""}{Math.abs(change).toFixed(2)} ({Math.abs(changePct).toFixed(2)}%)
            </span>
          ) : <span className="text-data text-muted">{replay ? "Change vs session open N/A" : "Day change N/A"}</span>}
          {replay && replayLoading ? <span className="text-data text-muted">Updating…</span> : null}
        </div>
        {replay ? (
          <div className="mt-2 space-y-0.5 text-data text-muted">
            <p><span className="font-medium text-text-2">Replay clock</span> <span className="num">{shortDate(replay.date)} · {replayCursor == null ? "—" : `${clockOf(replayCursor, true)} IST`}</span></p>
            <p>{replayQuote?.candleTime != null ? <>1-min close of the <span className="num">{clockOf(replayQuote.candleTime)}</span> IST candle{replayQuote.coverage.status !== "unavailable" ? ` · data ${replayQuote.coverage.status === "complete" ? "complete" : `partial (${replayQuote.coverage.minutes}/${replayQuote.coverage.expected} min)`}` : ""}</> : replayLoading ? "Loading historical premium…" : "No historical premium at this time"}</p>
          </div>
        ) : <p className="mt-1 text-data text-muted">Chain snapshot {asOf ? istTime(asOf) : "time unknown"} IST</p>}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <SegmentedControl
          label="Side"
          block
          value={action}
          onChange={chooseAction}
          options={[
            { id: "BUY", label: "Buy", tone: "profit" },
            { id: "SELL", label: "Sell", tone: "loss", disabled: held < 1, title: held < 1 ? "Sell closes lots you hold. Short options are not available." : "Sell to close" },
          ]}
        />

        <div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-2">Lots</span>
            <span className="num text-data text-muted">{quantity == null ? "—" : `${quantity.toLocaleString("en-IN")} qty (${lotSize} × ${parsed})`}</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Stepper label="Lots" value={lots} min={1} max={Math.max(1, maxLots)} invalid={Boolean(lots) && !validLots} onChange={setLots} />
            <div className="flex flex-1 flex-wrap justify-end gap-1">
              {LOT_CHIPS.map((chip) => (
                <button key={chip} type="button" disabled={chip > maxLots} aria-pressed={parsed === chip} onClick={() => setLots(String(chip))} className={cx("h-8 min-w-9 rounded-input border px-2 text-[13px] font-medium num", parsed === chip ? "border-primary bg-primary/12 text-primary" : "border-border text-text-2 hover:border-border-strong hover:text-text")}>{chip}</button>
              ))}
            </div>
          </div>
          {!buy ? <p className="mt-1.5 text-data text-muted">Sell to close only. You can close up to {held} lot{held === 1 ? "" : "s"}.</p> : null}
          {Boolean(lots) && !validLots ? <p className="mt-1.5 text-data text-loss">Enter between 1 and {Math.max(1, maxLots)} lots.</p> : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Order type">
            <SegmentedControl label="Order type" block size="sm" value="MARKET" onChange={() => undefined} options={[{ id: "MARKET", label: "Market" }, { id: "LIMIT", label: "Limit", disabled: true, title: "Not available in demo" }]} />
          </Field>
          <Field label="Product">
            <SegmentedControl label="Product" block size="sm" value="CARRY" onChange={() => undefined} options={[{ id: "INTRADAY", label: "Intraday", disabled: true, title: "Not available in demo" }, { id: "CARRY", label: "Carry" }]} />
          </Field>
        </div>

        <dl className="space-y-2 rounded-sheet border border-border bg-elevated p-3 text-[13px]">
          <Line label="Premium" value={premium == null ? "—" : inr(premium)} />
          <Line label="Quantity" value={quantity == null ? "—" : quantity.toLocaleString("en-IN")} />
          <Line label={buy ? "Total cost" : "Estimated exit value"} value={total == null ? "—" : inr(total)} strong />
          {!buy ? <Line label="Estimated realized P&L" value={estimate == null ? "—" : `${estimate > 0 ? "+" : ""}${inr(estimate)}`} tone={estimate == null ? undefined : estimate > 0 ? "text-profit" : estimate < 0 ? "text-loss" : undefined} /> : null}
          <div className="h-px bg-border" />
          <Line label="Buying power" value={buyingPower == null ? "N/A" : inr(buyingPower)} />
          <Line label="Buying power after order" value={after == null ? "N/A" : inr(after)} tone={short ? "text-loss" : undefined} />
          <p className="text-[11px] text-muted">Before simulated charges, which are added at fill.</p>
        </dl>

        {short ? <Notice tone="loss">Insufficient buying power for {parsed} lots. Reduce the lots to continue.</Notice> : null}

        {stale ? (
          <div className="flex items-center gap-2 rounded-input border border-warning/30 bg-warning/10 px-3 py-2 text-data text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1">Price snapshot is {Math.round((ageMs ?? 0) / 60_000) || 1} min old.</span>
            <Button size="sm" variant="secondary" loading={refreshing} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void refreshPrice()}>Refresh price</Button>
          </div>
        ) : null}

        {replay && !replayLoading && !replayReady ? (
          <Notice tone="loss" role="alert">
            {HISTORICAL_UNAVAILABLE}
            {historical?.error || replayQuote?.reason ? <span className="mt-1 block text-muted">{historical?.error || replayQuote?.reason}</span> : null}
          </Notice>
        ) : null}
        {replay && replayReady && replayQuote?.stale ? (
          <div className="flex items-center gap-2 rounded-input border border-warning/30 bg-warning/10 px-3 py-2 text-data text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1">Thinly traded: the last trade was {Math.max(1, Math.round((replayQuote.ageSeconds ?? 0) / 60))} min before the replay time.</span>
          </div>
        ) : null}

        {error ? <Notice tone="loss" role="alert">{error}</Notice> : null}

        <div>
          <button type="button" aria-expanded={details} className="flex w-full items-center gap-2 text-left text-data text-muted hover:text-text" onClick={() => setDetails((value) => !value)}>
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="flex-1">{replay ? "Demo order · historical premium at the replay clock" : "Demo order · uses chain snapshot price"}</span>
            <ChevronDown className={cx("h-3.5 w-3.5 transition-transform", details && "rotate-180")} aria-hidden />
          </button>
          {details ? (
            <p className="mt-2 pl-5 text-data leading-relaxed text-muted">
              {replay
                ? `Fill price: ${replayQuote?.policyLabel ?? "close of the last completed 1-minute candle at or before the replay time"}. The server re-reads this contract's history at the replay time shown and fills your practice account there. Candles after the replay time are never used, and the live chain is not used. If the contract did not trade in the 10 minutes before the replay time, the order is refused. `
                : "When you confirm, the server re-prices this contract from the latest option-chain snapshot and fills your practice account at that premium. If it moved more than 5% from the price shown, you are asked to review again. "}
              Nothing is sent to an exchange or broker.
            </p>
          ) : null}
        </div>
      </div>

      <footer className="flex gap-2 border-t border-border px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <Button variant={buy ? "buy" : "sell"} size="lg" block className="flex-1" loading={busy} disabled={blocked} onClick={() => void submit()}>{cta}</Button>
        <Button variant="ghost" size="lg" onClick={onClose}>Cancel</Button>
      </footer>
    </section>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-6 items-center rounded-xs border border-border bg-elevated px-2 text-data font-medium text-text-2">{children}</span>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><p className="mb-1.5 text-[13px] font-medium text-text-2">{label}</p>{children}</div>;
}
function Line({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className="text-muted">{label}</dt><dd className={cx("num text-right", strong ? "text-[15px] font-semibold text-text" : "text-text", tone)}>{value}</dd></div>;
}
function Notice({ tone, role, children }: { tone: "loss"; role?: string; children: ReactNode }) {
  return <p role={role} className={cx("rounded-input border px-3 py-2 text-data", tone === "loss" && "border-loss/30 bg-loss/10 text-loss")}>{children}</p>;
}
function rupees(value: string) {
  const number = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}
function inr(value: number, digits = 2) {
  return `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: digits === 0 && !Number.isInteger(value) ? 2 : digits, maximumFractionDigits: 2 })}`;
}
function clockOf(seconds: number, withSeconds = false) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}), hourCycle: "h23" }).format(new Date(seconds * 1000));
}
function shortDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}
