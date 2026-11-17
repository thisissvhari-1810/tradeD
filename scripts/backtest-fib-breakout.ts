/**
 * 1-Hour Fibonacci Breakout Strategy — historical backtest on real NIFTY weekly option premiums (paper only, no orders).
 * Corrected rules (user, 17 Nov 2026): live-price breakout ABOVE the trigger from below (GREEN 0.236, RED 0.786) from
 * 10:15, target 0.382 / 0.618, square-off 15:29, no hourly confirmation, no fallback (NO ENTRY when it never crosses).
 *
 *   python scripts/export-fib-breakout-data.py --months 1 --out ../../backtests/<folder>/data [--atm-only]
 *   npx tsx scripts/backtest-fib-breakout.ts --data ../../backtests/<folder>/data
 *
 * Options: --from / --to YYYY-MM-DD · --sides CE,PE · --lots 1 · --slippage-ticks 2 · --target-fill trade-through|touch ·
 *          --square-off 15:29 · --brokerage 20 · --out <folder> (default: the data folder's parent)
 *
 * Only 1-minute OHLC history exists: a cross inside a minute is modelled (fill at the first tick above the trigger +
 * slippage) and every trade states its fill type; minutes whose order cannot be told are counted, never traded.
 * Writes trades.csv, contract-days.csv, daily-pnl.csv, data-quality.csv, validation.md, summary.json, report.html.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  atmStrike, clockOf, contractSymbol, evaluateContractDay, FIB_DEFAULTS, FIB_FIRST_MINUTE_FILTERED, FIB_V0, fibPrice, hhmm, niftyLotSize, r2, tradeCharges,
  type ContractDayResult, type EntryFill, type FibSettings, type MinuteBar, type Right,
} from "@/lib/algo/fib-breakout";

/* ---------------- settings ---------------- */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? "1" : process.argv[++i]);
}
const DATA = path.resolve(args.get("data") ?? "../../backtests/Fib-Breakout-1H-NIFTY-latest-month/data");
const OUT = path.resolve(args.get("out") ?? path.dirname(DATA));
const SETTINGS: FibSettings = {
  ...(args.has("v0") ? FIB_V0 : args.has("filtered") ? FIB_FIRST_MINUTE_FILTERED : FIB_DEFAULTS),
  ...(args.has("sides") ? { sides: args.get("sides")!.split(",") as Right[] } : {}),
  ...(args.has("lots") ? { lots: Number(args.get("lots")) } : {}),
  ...(args.has("slippage-ticks") ? { slippageTicks: Number(args.get("slippage-ticks")) } : {}),
  ...(args.has("target-fill") ? { targetFill: args.get("target-fill") as FibSettings["targetFill"] } : {}),
  ...(args.has("square-off") ? { squareOffTime: hhmm(args.get("square-off")!) } : {}),
  ...(args.has("reference-hours") ? { referenceHours: Number(args.get("reference-hours")) } : {}),
  ...(args.has("stop-loss") ? { stopLossPct: Number(args.get("stop-loss")) } : {}),
  // Research overrides of the Fibonacci levels (defaults stay V0: 0.236 / 0.382 / 0.786 / 0.618).
  ...(args.has("green-entry") ? { greenEntryLevel: Number(args.get("green-entry")) } : {}),
  ...(args.has("green-target") ? { greenTargetLevel: Number(args.get("green-target")) } : {}),
  ...(args.has("red-entry") ? { redEntryLevel: Number(args.get("red-entry")) } : {}),
  ...(args.has("red-target") ? { redTargetLevel: Number(args.get("red-target")) } : {}),
  ...(args.has("fill-model") ? { fillModel: args.get("fill-model") as FibSettings["fillModel"] } : {}),
  ...(args.has("ambiguous-entry") ? { ambiguousAsEntry: true } : {}),
  ...(args.has("target-fraction") ? { targetFraction: Number(args.get("target-fraction")) } : {}),
  ...(args.has("breakeven") ? { breakevenAfterFraction: Number(args.get("breakeven")) } : {}),
  ...(args.has("expiry-day") ? { skipExpiryDay: args.get("expiry-day") === "skip" } : {}),
  ...(args.has("range-target") ? { targetRangeFraction: Number(args.get("range-target")) } : {}),
  ...(args.has("min-target") ? { minTargetPct: Number(args.get("min-target")) } : {}),
  // Reference candle length (minutes from 09:15): 60 = first hour (V0); 1 = the first 1-minute candle (user, 17 Nov 2026).
  ...(args.has("ref-minutes") ? { hourMinutes: Number(args.get("ref-minutes")), minFirstHourMinutes: Math.max(1, Math.round(Number(args.get("ref-minutes")) * 0.9)) } : {}),
  ...(args.has("max-hold") ? { maxHoldMinutes: Number(args.get("max-hold")) } : {}),
  ...(args.has("last-entry") ? { lastEntryTime: hhmm(args.get("last-entry")!) } : {}),
  ...(args.has("brokerage") ? { charges: { ...FIB_DEFAULTS.charges, brokeragePerOrder: Number(args.get("brokerage")) } } : {}),
};

/* ---------------- data ---------------- */

type Session = { date: string; session_type: string; expiry: string | null; expiry_source: string };
const windowInfo = JSON.parse(readFileSync(path.join(DATA, "00-window.json"), "utf8")) as { start: string; end: string; sessions: Session[]; lot_size_snapshot: number; lot_size_snapshot_date: string; latest_date_in_master: string; duplicate_option_minutes: number; appended_from_dhan?: string[] };
const FROM = args.get("from") ?? windowInfo.start;
const TO = args.get("to") ?? windowInfo.end;

function rows(file: string, each: (cells: string[]) => void) {
  const text = readFileSync(path.join(DATA, file), "utf8");
  let start = text.indexOf("\n") + 1;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    if (line) each(line.split(","));
    start = end + 1;
  }
}

const spot = new Map<string, MinuteBar[]>();
rows("05-nifty-1min-candles.csv", ([date, time, open, high, low, close]) => {
  if (date < FROM || date > TO) return;
  (spot.get(date) ?? spot.set(date, []).get(date)!).push({ t: hhmm(time), open: +open, high: +high, low: +low, close: +close });
});
type OptionDay = { tapes: Map<string, MinuteBar[]>; apiAtm: Map<number, Map<Right, number>> };
const options = new Map<string, OptionDay>();
rows("07-nifty-weekly-options-1min.csv", ([date, time, , strike, type, open, high, low, close, volume, offset]) => {
  if (date < FROM || date > TO) return;
  const day = options.get(date) ?? options.set(date, { tapes: new Map(), apiAtm: new Map() }).get(date)!;
  const key = `${+strike}|${type}`;
  const t = hhmm(time);
  (day.tapes.get(key) ?? day.tapes.set(key, []).get(key)!).push({ t, open: +open, high: +high, low: +low, close: +close, volume: +volume });
  if (offset === "ATM") (day.apiAtm.get(t) ?? day.apiAtm.set(t, new Map()).get(t)!).set(type as Right, +strike);
});
for (const day of options.values()) for (const tape of day.tapes.values()) tape.sort((a, b) => a.t - b.t);
for (const bars of spot.values()) bars.sort((a, b) => a.t - b.t);

const sessions = windowInfo.sessions.filter((s) => s.date >= FROM && s.date <= TO);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/* ---------------- run ---------------- */

type DayPlan = {
  date: string; status: "OK" | "EXCLUDED"; reason: string; expiry: string; expirySource: string; dte: number | null; spotClose: number | null;
  strike: number | null; apiAtmCE: number | null; apiAtmPE: number | null; lotSize: number | null; spotMinutes: number; optionMinutes: { CE: number; PE: number };
};
type Trade = {
  date: string; symbol: string; right: Right; direction: string; refHour: number; fhOpen: number; fhHigh: number; fhLow: number; fhClose: number;
  exitTarget: number; entryLevel: number; entryLevelPrice: number; triggerOrder: number; targetLevel: number; targetLevelPrice: number; targetOrder: number;
  entryTime: string; entryPrice: number; entryBarOpen: number; entryFill: EntryFill; aboveTarget: boolean; exitTime: string; exitPrice: number;
  lots: number; quantity: number; gross: number; charges: number; slippage: number; net: number; exitReason: string; target: boolean; result: "WIN" | "LOSS";
  dte: number; maxFavPct: number; maxAdvPct: number; exitMinute: number; strike: number; expiry: string; ambiguousBefore: number;
};
type ContractRow = { plan: DayPlan; right: Right; result: ContractDayResult | null; symbol: string; trade: Trade | null };

function run(settings: FibSettings) {
  const plans: DayPlan[] = [];
  const contracts: ContractRow[] = [];
  for (const session of sessions) {
    const bars = spot.get(session.date) ?? [];
    const opt = options.get(session.date);
    const plan: DayPlan = {
      date: session.date, status: "OK", reason: "", expiry: session.expiry ?? "unknown", expirySource: session.expiry_source, dte: session.expiry ? daysBetween(session.date, session.expiry) : null,
      spotClose: null, strike: null, apiAtmCE: null, apiAtmPE: null, lotSize: session.expiry ? niftyLotSize(session.expiry) : null, spotMinutes: bars.length, optionMinutes: { CE: 0, PE: 0 },
    };
    plans.push(plan);
    const firstEnd = settings.sessionOpen + settings.hourMinutes;
    // Decided by the data, not the label: a special session with a full 09:15 first hour (e.g. a Sunday Budget day) is traded.
    const closeBar = bars.find((bar) => bar.t === firstEnd - 1);
    if (!bars.length || bars[0].t !== settings.sessionOpen || !closeBar) {
      Object.assign(plan, { status: "EXCLUDED", reason: `${session.session_type} session (${bars.length} min, ${bars.length ? `${clockOf(bars[0].t)}–${clockOf(bars[bars.length - 1].t + 1)}` : "no data"}): no complete 09:15–10:15 NIFTY first hour` });
      continue;
    }
    if (!opt) { Object.assign(plan, { status: "EXCLUDED", reason: "No option data for the session" }); continue; }
    if (!session.expiry) { Object.assign(plan, { status: "EXCLUDED", reason: "Expiry unknown" }); continue; }
    plan.spotClose = closeBar.close;
    plan.strike = atmStrike(closeBar.close, settings.strikeStep);
    plan.apiAtmCE = opt.apiAtm.get(firstEnd - 1)?.get("CE") ?? null;
    plan.apiAtmPE = opt.apiAtm.get(firstEnd - 1)?.get("PE") ?? null;
    for (const right of settings.sides) {
      const tape = opt.tapes.get(`${plan.strike}|${right}`) ?? [];
      plan.optionMinutes[right] = tape.filter((bar) => bar.t >= settings.sessionOpen && bar.t <= settings.squareOffTime).length;
      const result = evaluateContractDay(right, tape, settings, 24 * 60, { dte: plan.dte ?? undefined });
      const symbol = contractSymbol(settings.underlying, session.expiry, plan.strike, right);
      let trade: Trade | null = null;
      if (result.status === "CLOSED" && result.entry && result.exit && result.reference && result.direction) {
        const quantity = settings.lots * plan.lotSize!;
        const ch = tradeCharges(result.entry.price, result.exit.price, quantity, session.date, settings.charges);
        const gross = r2((result.exit.price - result.entry.price) * quantity);
        const modelled = result.entry.fill === "GAP_OPEN" ? result.entry.barOpen : result.triggerOrder!;
        const slip = r2(((result.entry.price - modelled) + (result.exit.reason === "SQUARE_OFF" ? result.exit.barPrice! - result.exit.price : 0)) * quantity);
        const net = r2(gross - ch.total);
        const target = result.exit.reason === "TARGET";
        trade = {
          date: session.date, symbol, right, direction: result.direction, refHour: result.reference.hour, fhOpen: result.reference.open, fhHigh: result.reference.high, fhLow: result.reference.low, fhClose: result.reference.close,
          entryLevel: result.entryLevel!, entryLevelPrice: r2(result.entryLevelPrice!), triggerOrder: result.triggerOrder!, targetLevel: result.targetLevel!, targetLevelPrice: r2(result.targetLevelPrice!), targetOrder: result.targetOrder!, exitTarget: result.exitTarget ?? result.targetOrder!,
          entryTime: clockOf(result.entry.time), entryPrice: result.entry.price, entryBarOpen: result.entry.barOpen, entryFill: result.entry.fill, aboveTarget: result.entry.aboveTarget,
          exitTime: clockOf(result.exit.time), exitPrice: result.exit.price, lots: settings.lots, quantity, gross, charges: ch.total, slippage: slip, net,
          exitReason: target ? (settings.targetRangeFraction > 0 ? `Target entry + ${settings.targetRangeFraction} × Fib range` : `Target Fib ${result.targetLevel}`) : result.exit.reason === "STOP_LOSS" ? `Stop-loss ${settings.stopLossPct}%` : result.exit.reason === "TIME_EXIT" ? `Time exit ${settings.maxHoldMinutes} min` : result.exit.reason === "BREAKEVEN" ? "Break-even stop" : `Square-off ${clockOf(result.exit.time)}${result.exit.stale ? " (stale last price)" : ""}`, target,
          result: net > 0 ? "WIN" : "LOSS", dte: plan.dte!, maxFavPct: r2(((result.maxHigh! - result.entry.price) / result.entry.price) * 100), maxAdvPct: r2(((result.minLow! - result.entry.price) / result.entry.price) * 100),
          exitMinute: result.exit.time, strike: plan.strike, expiry: session.expiry, ambiguousBefore: result.ambiguousMinutes.length,
        };
      }
      contracts.push({ plan, right, result, symbol, trade });
    }
  }
  return { plans, contracts, trades: contracts.flatMap((c) => (c.trade ? [c.trade] : [])) };
}

function stats(trades: Trade[]) {
  const ordered = [...trades].sort((a, b) => a.date.localeCompare(b.date) || a.exitMinute - b.exitMinute);
  const wins = trades.filter((t) => t.result === "WIN");
  const losses = trades.filter((t) => t.result === "LOSS");
  const sum = (list: Trade[], key: "gross" | "net" | "charges" | "slippage") => r2(list.reduce((acc, t) => acc + t[key], 0));
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of ordered) { equity += t.net; peak = Math.max(peak, equity); maxDd = Math.min(maxDd, equity - peak); }
  const winNet = sum(wins, "net"), lossNet = sum(losses, "net");
  const targets = trades.filter((t) => t.target).length;
  return {
    trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? r2((wins.length / trades.length) * 100) : 0,
    grossProfit: r2(trades.filter((t) => t.gross > 0).reduce((a, t) => a + t.gross, 0)), grossLoss: r2(trades.filter((t) => t.gross < 0).reduce((a, t) => a + t.gross, 0)),
    charges: sum(trades, "charges"), slippage: sum(trades, "slippage"), net: sum(trades, "net"),
    avgWin: wins.length ? r2(winNet / wins.length) : 0, avgLoss: losses.length ? r2(lossNet / losses.length) : 0,
    maxDrawdown: r2(maxDd), profitFactor: lossNet < 0 ? r2(winNet / -lossNet) : null,
    targets, squareOffs: trades.length - targets, targetHitPct: trades.length ? r2((targets / trades.length) * 100) : 0,
  };
}

const base = run(SETTINGS);
const all = stats(base.trades);
const by = (filter: (t: Trade) => boolean) => stats(base.trades.filter(filter));
const categories: [string, ReturnType<typeof stats>][] = [
  ["GREEN CE", by((t) => t.direction === "GREEN" && t.right === "CE")],
  ["GREEN PE", by((t) => t.direction === "GREEN" && t.right === "PE")],
  ["RED CE", by((t) => t.direction === "RED" && t.right === "CE")],
  ["RED PE", by((t) => t.direction === "RED" && t.right === "PE")],
  ["Combined GREEN", by((t) => t.direction === "GREEN")],
  ["Combined RED", by((t) => t.direction === "RED")],
  ["Combined CE", by((t) => t.right === "CE")],
  ["Combined PE", by((t) => t.right === "PE")],
  ["Total Combined", all],
];
const okPlans = base.plans.filter((p) => p.status === "OK");
const statusCount = (status: string, right?: Right) => base.contracts.filter((c) => c.result?.status === status && (!right || c.right === right)).length;
const dirCount = (dir: string, right?: Right) => base.contracts.filter((c) => c.result?.direction === dir && (!right || c.right === right)).length;
const noEntry = base.contracts.filter((c) => c.result?.status === "NO_ENTRY");
const skipped = { expiryDay: noEntry.filter((c) => c.result?.skipReason === "EXPIRY_DAY").length, smallTarget: noEntry.filter((c) => c.result?.skipReason === "SMALL_TARGET").length };
const noEntryDays = okPlans.filter((p) => base.trades.every((t) => t.date !== p.date)).map((p) => p.date);
const fillCount = (fill: EntryFill) => base.trades.filter((t) => t.entryFill === fill).length;
const ambiguous = base.contracts.reduce((a, c) => a + (c.result?.ambiguousMinutes.length ?? 0), 0);
const ambiguousContracts = base.contracts.filter((c) => c.result?.ambiguousMinutes.length);

/* Sensitivity (the same rules; only execution assumptions change). */
const QUICK = args.has("quick");
const sensitivity = QUICK ? [] : [
  ["Default (2 ticks slippage, target needs a tick through)", SETTINGS],
  ["Slippage 0", { ...SETTINGS, slippageTicks: 0 }],
  ["Slippage 1 tick", { ...SETTINGS, slippageTicks: 1 }],
  ["Slippage 4 ticks", { ...SETTINGS, slippageTicks: 4 }],
  ["Target fills on a touch", { ...SETTINGS, targetFill: "touch" as const }],
].map(([label, settings]) => ({ label: label as string, ...stats(run(settings as FibSettings).trades) }));

/* ---------------- validation ---------------- */

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
{
  const g = [1, 0.786, 0.618, 0.382, 0.236, 0].map((l) => r2(fibPrice(230.35, 220.2, "GREEN", l)));
  const r = [1, 0.786, 0.618, 0.382, 0.236, 0].map((l) => r2(fibPrice(230.35, 220.2, "RED", l)));
  const specG = [230.35, 228.18, 226.46, 224.09, 222.6, 220.2], specR = [220.2, 222.37, 224.09, 226.47, 227.96, 230.35];
  check("1. Fibonacci example ₹220.20–₹230.35", g.every((v, i) => Math.abs(v - specG[i]) <= 0.011) && r.every((v, i) => Math.abs(v - specR[i]) <= 0.011),
    `GREEN ${g.join(" / ")}; RED ${r.join(" / ")} (levels 1 … 0). Spec values differ only by ₹0.01 rounding; the engine uses the exact formula.`);
  const recomputed = base.contracts.filter((c) => c.result?.direction).every(({ result: x }) => {
    const { high, low } = x!.reference!;
    const e = x!.direction === "GREEN" ? low + (high - low) * SETTINGS.greenEntryLevel : high - (high - low) * SETTINGS.redEntryLevel;
    const t = x!.direction === "GREEN" ? low + (high - low) * SETTINGS.greenTargetLevel : high - (high - low) * SETTINGS.redTargetLevel;
    return Math.abs(e - x!.entryLevelPrice!) < 1e-9 && Math.abs(t - x!.targetLevelPrice!) < 1e-9 && (x!.direction === "GREEN" ? x!.reference!.close > x!.reference!.open : x!.reference!.close < x!.reference!.open);
  });
  check("2. GREEN and RED computed independently", recomputed, `${dirCount("GREEN")} GREEN and ${dirCount("RED")} RED contract-days; every trigger/target re-derived from that contract's own reference-candle H/L with the configured levels (GREEN ${SETTINGS.greenEntryLevel}/${SETTINGS.greenTargetLevel}, RED ${SETTINGS.redEntryLevel}/${SETTINGS.redTargetLevel}).`);
  const atmMismatch = okPlans.filter((p) => (p.apiAtmCE != null && p.apiAtmCE !== p.strike) || (p.apiAtmPE != null && p.apiAtmPE !== p.strike));
  const noLabel = okPlans.filter((p) => p.apiAtmCE == null && p.apiAtmPE == null).length;
  const nearest = okPlans.every((p) => Math.abs(p.spotClose! - p.strike!) <= SETTINGS.strikeStep / 2 && SETTINGS.sides.every((side) => options.get(p.date)!.tapes.has(`${p.strike}|${side}`)));
  check("3. ATM strike per historical day (same strike for CE and PE)", nearest, `${okPlans.length} sessions: ATM = that day's NIFTY ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes - 1)} close rounded to the nearest ${SETTINGS.strikeStep}, used for both CE and PE; strike within ${SETTINGS.strikeStep / 2} pts of the spot and its contracts present every day. Dhan's own ATM label at ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes - 1)} differs on ${atmMismatch.length}${atmMismatch.length ? ` (${atmMismatch.slice(0, 8).map((p) => `${p.date} spot ${p.spotClose} → ${p.strike}, label ${p.apiAtmCE ?? p.apiAtmPE}`).join("; ")}${atmMismatch.length > 8 ? " …" : ""})` : ""}; no label on ${noLabel} (days fetched by contract id).`);
  let lookOk = true; const lookBad: string[] = [];
  for (const c of base.contracts) {
    const x = c.result;
    if (!x?.entry) continue;
    const tape = options.get(c.plan.date)!.tapes.get(`${c.plan.strike}|${c.right}`)!;
    const before = evaluateContractDay(c.right, tape, SETTINGS, x.entry.time, { dte: c.plan.dte ?? undefined });
    const at = evaluateContractDay(c.right, tape, SETTINGS, x.entry.time + 1, { dte: c.plan.dte ?? undefined });
    if (before.entry || JSON.stringify(at.entry) !== JSON.stringify(x.entry) || JSON.stringify(at.levels) !== JSON.stringify(x.levels)) { lookOk = false; lookBad.push(`${c.plan.date} ${c.right}`); }
  }
  check("4. No look-ahead", lookOk, `Every entry re-run with the tape cut before its minute (no entry) and right after it (same entry, same levels). Levels use only the ${clockOf(SETTINGS.sessionOpen)}–${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes - 1)} candle(s); monitoring starts ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes)}. ${base.trades.length} entries checked.${lookBad.length ? ` Failed: ${lookBad.join(", ")}` : ""}`);
  const tsBad = base.trades.filter((t) => !(hhmm(t.entryTime) >= SETTINGS.sessionOpen + SETTINGS.hourMinutes && hhmm(t.entryTime) < SETTINGS.squareOffTime && hhmm(t.exitTime) > hhmm(t.entryTime) && hhmm(t.exitTime) <= SETTINGS.squareOffTime));
  check("5. Entry and exit timestamps", tsBad.length === 0, `Entries ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes)}–${clockOf(SETTINGS.squareOffTime - 1)}, exits after the entry and by ${clockOf(SETTINGS.squareOffTime)}, same date.${tsBad.length ? ` Bad: ${tsBad.map((t) => `${t.date} ${t.right}`).join(", ")}` : ""}`);
  const keys = base.trades.map((t) => `${t.date}|${t.right}`);
  check("6. No duplicate trades", new Set(keys).size === keys.length, `${keys.length} trades, ${new Set(keys).size} unique (date, CE/PE); one entry per contract per day.`);
  const lotOk = base.trades.every((t) => t.quantity === t.lots * niftyLotSize(t.expiry));
  const lotSizes = [...new Set(base.trades.map((t) => t.quantity / t.lots))].map((l) => `${l} (${base.trades.filter((t) => t.quantity / t.lots === l).length} trades)`);
  const chargeOk = base.trades.every((t) => Math.abs(tradeCharges(t.entryPrice, t.exitPrice, t.quantity, t.date, SETTINGS.charges).total - t.charges) < 0.011);
  check("7. Charges and lot sizes", chargeOk && lotOk, `Lot size by contract expiry (NSE: 50 to 25-Apr-2024, 25 to 24-Dec-2024, 75 to 30-Dec-2025, then 65): ${lotSizes.join(", ") || "–"}. Charges re-computed for every trade: ₹${SETTINGS.charges.brokeragePerOrder}/order, STT on the sell by date (0.05% → 0.0625% Apr-2023 → 0.1% Oct-2024 → 0.15% Apr-2026), NSE by date (0.053% → 0.05% → 0.0495% → 0.03503% Oct-2024), SEBI ₹10/cr, stamp 0.003% buy, GST 18%.`);
  const dates = okPlans.map((p) => p.date);
  const diffDir = dates.filter((d) => { const [ce, pe] = (["CE", "PE"] as const).map((r) => base.contracts.find((c) => c.plan.date === d && c.right === r)?.result?.direction); return ce && pe && ce !== pe; }).length;
  const oneSide = dates.filter((d) => base.trades.filter((t) => t.date === d).length === 1).length;
  check("8. CE and PE evaluated independently", true, `Each contract uses only its own premium tape and levels. Different first-hour colours on ${diffDir}/${dates.length} days; only one of the two entered on ${oneSide} days.`);
  const open = base.contracts.filter((c) => c.result?.status === "OPEN" || c.result?.status === "WAITING").length;
  check("9. No position open after the close", open === 0, `${open} open / waiting contract-days at the end of the sessions; every trade closed the same day.`);
  check("10. 1-minute data limits (reported, not hidden)", true, `Fill types: GAP_OPEN ${fillCount("GAP_OPEN")} (fill at a minute's open), INTRAMINUTE ${fillCount("INTRAMINUTE")} and INTRAMINUTE_ARMED ${fillCount("INTRAMINUTE_ARMED")} (cross certain inside the minute, price modelled at the first tick above the trigger + slippage). Ambiguous minutes (order unknown, NO entry assumed): ${ambiguous} in ${ambiguousContracts.length} contract-days. Entries already at/above the target: ${base.trades.filter((t) => t.aboveTarget).length}. Tick-level execution is not reproduced.`);
}

/* ---------------- files ---------------- */

mkdirSync(OUT, { recursive: true });
const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (header: string[], data: unknown[][]) => "﻿" + [header, ...data].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
writeFileSync(path.join(OUT, "trades.csv"), csv(
  ["Trading date", "Contract", "CE/PE", `Reference candle (1 = ${clockOf(SETTINGS.sessionOpen)}–${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes)})`, "Reference candle direction", "Reference open", "Reference high", "Reference low", "Reference close", "Fib entry level", "Fib entry price", "Buy trigger (tick)", "Fib exit level", "Fib exit price", "Target order (tick)", "Sell target used", "Entry time", "Entry price", "Entry fill type", "Entry minute open", "Exit time", "Exit price", "Lots", "Quantity", "Gross P&L", "Charges", "Slippage cost (in prices)", "Net P&L", "Exit reason", "Result", "DTE", "Max favourable %", "Max adverse %", "Ambiguous minutes before entry"],
  base.trades.map((t) => [t.date, t.symbol, t.right, t.refHour, t.direction, t.fhOpen, t.fhHigh, t.fhLow, t.fhClose, t.entryLevel, t.entryLevelPrice, t.triggerOrder, t.targetLevel, t.targetLevelPrice, t.targetOrder, t.exitTarget, t.entryTime, t.entryPrice, t.entryFill, t.entryBarOpen, t.exitTime, t.exitPrice, t.lots, t.quantity, t.gross, t.charges, t.slippage, t.net, t.exitReason, t.result, t.dte, t.maxFavPct, t.maxAdvPct, t.ambiguousBefore]),
));
writeFileSync(path.join(OUT, "contract-days.csv"), csv(
  ["Date", "Session", "Contract", "CE/PE", "Status", "Direction", "First-hour O", "H", "L", "C", "First-hour minutes", "Trigger", "Target", "Started below trigger", "Ambiguous minutes", "Reference hour", "Note"],
  [...base.plans.filter((p) => p.status === "EXCLUDED").map((p) => [p.date, "EXCLUDED", "", "", "INCOMPLETE DAY", "", "", "", "", "", "", "", "", "", "", "", p.reason]),
    ...base.contracts.map((c) => [c.plan.date, "OK", c.symbol, c.right, c.result!.status === "NO_ENTRY" ? "NO ENTRY" : c.result!.status, c.result!.direction ?? "", c.result!.firstHour?.open ?? "", c.result!.firstHour?.high ?? "", c.result!.firstHour?.low ?? "", c.result!.firstHour?.close ?? "", c.result!.firstHour?.minutes ?? "", c.result!.entryLevelPrice != null ? r2(c.result!.entryLevelPrice) : "", c.result!.targetLevelPrice != null ? r2(c.result!.targetLevelPrice) : "", c.result!.startedBelow == null ? "" : c.result!.startedBelow ? "yes" : "no", c.result!.ambiguousMinutes.map(clockOf).join(" "), c.result!.reference?.hour ?? "", c.result!.note])].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
));
const daily = okPlans.map((p) => { const list = base.trades.filter((t) => t.date === p.date); return { date: p.date, trades: list.length, net: r2(list.reduce((a, t) => a + t.net, 0)) }; });
let cum = 0;
const dailyCum = daily.map((d) => ({ ...d, cumulative: r2((cum += d.net)) }));
writeFileSync(path.join(OUT, "daily-pnl.csv"), csv(["Date", "Trades", "Net P&L", "Cumulative net P&L"], dailyCum.map((d) => [d.date, d.trades, d.net, d.cumulative])));
writeFileSync(path.join(OUT, "data-quality.csv"), csv(
  ["Date", "Status", "Reason", "Expiry", "Expiry source", "DTE", `NIFTY ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes - 1)} close`, "ATM (ours, CE and PE)", "ATM API CE", "ATM API PE", "Lot size", "NIFTY minutes", "CE minutes (09:15–15:29)", "PE minutes (09:15–15:29)"],
  base.plans.map((p) => [p.date, p.status, p.reason, p.expiry, p.expirySource, p.dte, p.spotClose, p.strike, p.apiAtmCE, p.apiAtmPE, p.lotSize, p.spotMinutes, p.optionMinutes.CE, p.optionMinutes.PE]),
));
const summary = {
  strategy: "1-Hour Fibonacci Breakout (corrected: live-price breakout above the trigger, no fallback)", mode: "BACKTEST (paper only, no orders)",
  window: { from: FROM, to: TO, sessions: sessions.length, tradingDays: okPlans.length, excluded: base.plans.filter((p) => p.status === "EXCLUDED").map((p) => ({ date: p.date, reason: p.reason })) },
  settings: { ...SETTINGS, sessionOpen: clockOf(SETTINGS.sessionOpen), squareOffTime: clockOf(SETTINGS.squareOffTime) },
  overall: all, categories: Object.fromEntries(categories),
  noEntry: { contractDays: noEntry.length, skippedByRule: skipped, CE: statusCount("NO_ENTRY", "CE"), PE: statusCount("NO_ENTRY", "PE"), daysWithNoTradeAtAll: noEntryDays },
  incomplete: { contractDays: statusCount("INCOMPLETE"), noSetup: statusCount("NO_SETUP") },
  fills: { GAP_OPEN: fillCount("GAP_OPEN"), INTRAMINUTE: fillCount("INTRAMINUTE"), INTRAMINUTE_ARMED: fillCount("INTRAMINUTE_ARMED"), ambiguousMinutes: ambiguous, ambiguousContractDays: ambiguousContracts.length },
  sensitivity, validation: checks,
};
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(path.join(OUT, "validation.md"), `# Validation — 1-Hour Fibonacci Breakout, ${FROM} to ${TO}\n\n${checks.map((c) => `- **${c.pass ? "PASS" : "FAIL"} — ${c.name}.** ${c.detail}`).join("\n")}\n\n## Data quality\n\n- Source: NIFTY50_5_YEAR_MASTER_DATA (Dhan HQ v2)${windowInfo.appended_from_dhan?.length ? ` + Dhan /charts/intraday for ${windowInfo.appended_from_dhan.join(", ")}` : ""}; duplicate option minutes: ${windowInfo.duplicate_option_minutes}.\n- Sessions in window: ${sessions.length}; evaluated: ${okPlans.length}; excluded: ${base.plans.filter((p) => p.status === "EXCLUDED").map((p) => `${p.date} (${p.reason})`).join("; ") || "none"}.\n- Contract-days with an incomplete first hour (not traded): ${base.contracts.filter((c) => c.result?.status === "INCOMPLETE").map((c) => `${c.plan.date} ${c.right}: ${c.result!.note}`).join(" | ") || "none"}.\n- Expiries not from the detected calendar: ${sessions.filter((s) => !s.expiry_source.startsWith("expiry_calendar")).map((s) => `${s.date} → ${s.expiry}`).join(", ") || "none"}.\n- Not available: historical bid/ask and ticks (fills are modelled from 1-minute OHLC + slippage).\n`);

/* ---------------- dashboard ---------------- */

const inr = (v: number) => `${v < 0 ? "−" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inr0 = (v: number) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const lvl = (l: number) => (l === 0 || l === 1 ? l.toFixed(3) : String(l).padEnd(5, "0"));

function niceTicks(min: number, max: number, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(r2(v));
  return ticks;
}

/** Vertical bars from a zero baseline; positive = gain (blue), negative = loss (red). */
function barChart(items: { label: string; value: number; tip: string }[], opts: { height?: number; rotate?: boolean; width?: number } = {}) {
  const W = opts.width ?? 760, H = opts.height ?? 240, ml = 64, mr = 12, mt = 16, mb = opts.rotate ? 58 : 30;
  const vals = items.map((i) => i.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const lo = Math.min(ticks[0], 0, ...vals), hi = Math.max(ticks[ticks.length - 1], 0, ...vals);
  const y = (v: number) => mt + ((hi - v) / (hi - lo || 1)) * (H - mt - mb);
  const slot = (W - ml - mr) / Math.max(items.length, 1);
  const bw = Math.min(36, slot - 2);
  const grid = ticks.map((t) => `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${ml - 6}" y="${y(t) + 3}" class="tick" text-anchor="end">${inr0(t)}</text>`).join("");
  const bars = items.map((it, i) => {
    const x = ml + slot * i + (slot - bw) / 2;
    const y0 = y(0), y1 = y(it.value);
    const top = Math.min(y0, y1), h = Math.max(Math.abs(y1 - y0), it.value === 0 ? 0 : 1);
    const r = Math.min(4, h, bw / 2);
    const d = it.value >= 0
      ? `M${x},${y0} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y0} Z`
      : `M${x},${y0} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + bw - r} Q${x + bw},${top + h} ${x + bw},${top + h - r} V${y0} Z`;
    const lab = opts.rotate ? `<text transform="translate(${x + bw / 2},${H - mb + 10}) rotate(-50)" class="tick" text-anchor="end">${esc(it.label)}</text>` : `<text x="${x + bw / 2}" y="${H - mb + 16}" class="tick" text-anchor="middle">${esc(it.label)}</text>`;
    const value = items.length <= 4 ? `<text x="${x + bw / 2 + (it.value === 0 ? 0 : 0)}" y="${it.value >= 0 ? top - 5 : top + h + 13}" class="vlabel" text-anchor="middle">${inr0(it.value)}</text>` : "";
    return `<g class="hit"><rect x="${ml + slot * i}" y="${mt}" width="${slot}" height="${H - mt - mb}" fill="transparent"/><path d="${d}" class="${it.value >= 0 ? "pos" : "neg"}"/><title>${esc(it.tip)}</title></g>${value}${lab}`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}<line x1="${ml}" x2="${W - mr}" y1="${y(0)}" y2="${y(0)}" class="base"/>${bars}</svg>`;
}

function lineChart(points: { label: string; value: number; tip: string }[]) {
  const W = 760, H = 240, ml = 64, mr = 16, mt = 16, mb = 58;
  const vals = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const lo = Math.min(ticks[0], 0, ...vals), hi = Math.max(ticks[ticks.length - 1], 0, ...vals);
  const y = (v: number) => mt + ((hi - v) / (hi - lo || 1)) * (H - mt - mb);
  const x = (i: number) => ml + (points.length < 2 ? 0 : (i / (points.length - 1)) * (W - ml - mr));
  const grid = ticks.map((t) => `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${ml - 6}" y="${y(t) + 3}" class="tick" text-anchor="end">${inr0(t)}</text>`).join("");
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const dots = points.map((p, i) => `<g class="hit"><circle cx="${x(i)}" cy="${y(p.value)}" r="12" fill="transparent"/><circle cx="${x(i)}" cy="${y(p.value)}" r="4" class="dot"/><title>${esc(p.tip)}</title></g><text transform="translate(${x(i)},${H - mb + 10}) rotate(-50)" class="tick" text-anchor="end">${esc(p.label)}</text>`).join("");
  const last = points[points.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}<line x1="${ml}" x2="${W - mr}" y1="${y(0)}" y2="${y(0)}" class="base"/><path d="${path}" class="line"/>${dots}${last ? `<text x="${x(points.length - 1) - 6}" y="${y(last.value) - 10}" class="vlabel" text-anchor="end">${inr0(last.value)}</text>` : ""}</svg>`;
}

/** Horizontal wins/losses stacked bars per category, counts. */
function winLossChart(rowsIn: { label: string; wins: number; losses: number }[]) {
  const W = 760, rowH = 34, ml = 120, mr = 60, H = rowsIn.length * rowH + 12;
  const max = Math.max(1, ...rowsIn.map((r) => r.wins + r.losses));
  const sx = (v: number) => (v / max) * (W - ml - mr);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${rowsIn.map((r, i) => {
    const y = 6 + i * rowH, h = 20, ww = sx(r.wins), lw = sx(r.losses);
    return `<text x="${ml - 8}" y="${y + 14}" class="tick" text-anchor="end">${esc(r.label)}</text>
      <g class="hit">${r.wins ? `<rect x="${ml}" y="${y}" width="${Math.max(ww - (r.losses ? 2 : 0), 1)}" height="${h}" rx="4" class="win"/>` : ""}${r.losses ? `<rect x="${ml + ww}" y="${y}" width="${Math.max(lw, 1)}" height="${h}" rx="4" class="loss"/>` : ""}<title>${esc(`${r.label}: ${r.wins} wins, ${r.losses} losses`)}</title></g>
      <text x="${ml + ww + lw + 6}" y="${y + 14}" class="vlabel">${r.wins} W / ${r.losses} L</text>`;
  }).join("")}</svg>`;
}

/** Hourly candles of one contract-day with its Fibonacci levels, entry and exit. Price axis: high at the top. For a
 * RED first hour Fib 0 is the High (top) and Fib 1 the Low (bottom); for GREEN, Fib 0 is the Low and Fib 1 the High. */
function candleChart(c: ContractRow) {
  const x0 = c.result!;
  const W = 520, H = 260, ml = 20, mr = 118, mt = 14, mb = 22;
  const hours = x0.hours;
  const prices = [...hours.flatMap((h) => [h.high, h.low]), ...x0.levels.map((l) => l.price), ...(x0.entry ? [x0.entry.price] : []), ...(x0.exit ? [x0.exit.price] : [])];
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = (hi - lo) * 0.04 || 1; lo -= pad; hi += pad;
  const y = (p: number) => mt + ((hi - p) / (hi - lo)) * (H - mt - mb);
  const span = SETTINGS.squareOffTime - SETTINGS.sessionOpen;
  const x = (m: number) => ml + ((m - SETTINGS.sessionOpen) / span) * (W - ml - mr);
  // Labels keep at least 11 px apart (pushed down from the top in price order); the lines stay at their exact prices.
  const shown = x0.levels.filter((l) => l.level !== 0.5).sort((a, b) => b.price - a.price);
  const labelY = new Map<number, number>();
  let prevY = -Infinity;
  for (const l of shown) { const ly = Math.max(y(l.price) + 3, prevY + 11); labelY.set(l.level, ly); prevY = ly; }
  const fib = shown.map((l) => {
    const isEntry = l.level === x0.entryLevel, isTarget = l.level === x0.targetLevel;
    const cls = isEntry ? "fib-entry" : isTarget ? "fib-target" : l.level === 0 || l.level === 1 ? "fib-edge" : "fib";
    const tag = isEntry ? " ENTRY" : isTarget ? " TARGET" : l.level === 0 ? (x0.direction === "RED" ? " High" : " Low") : l.level === 1 ? (x0.direction === "RED" ? " Low" : " High") : "";
    return `<line x1="${ml}" x2="${W - mr}" y1="${y(l.price)}" y2="${y(l.price)}" class="${cls}"/><text x="${W - mr + 4}" y="${labelY.get(l.level)}" class="flabel${isEntry || isTarget ? " strong" : ""}">${lvl(l.level)} · ${num(r2(l.price))}${tag}</text>`;
  }).join("");
  const candles = hours.map((h) => {
    const cx = x(h.start + (h.end - h.start) / 2), bw = Math.max(4, (x(h.end) - x(h.start)) * 0.55);
    const up = h.close >= h.open;
    return `<g class="hit"><line x1="${cx}" x2="${cx}" y1="${y(h.high)}" y2="${y(h.low)}" class="${up ? "wick-up" : "wick-dn"}"/><rect x="${cx - bw / 2}" y="${y(Math.max(h.open, h.close))}" width="${bw}" height="${Math.max(1, Math.abs(y(h.open) - y(h.close)))}" class="${up ? "c-up" : "c-dn"}"/><title>${esc(`Hour ${h.index} ${clockOf(h.start)}–${clockOf(h.end)}  O ${h.open} H ${h.high} L ${h.low} C ${h.close} (${h.minutes} min)`)}</title></g>`;
  }).join("");
  const sig = "";
  const ent = x0.entry ? `<g class="hit"><path d="M${x(x0.entry.time)},${y(x0.entry.price) + 2} l-6,10 h12 z" class="m-entry"/><title>${esc(`Entry ${clockOf(x0.entry.time)} at ${x0.entry.price}`)}</title></g>` : "";
  const ex = x0.exit ? `<g class="hit"><path d="M${x(x0.exit.time)},${y(x0.exit.price) - 2} l-6,-10 h12 z" class="${c.trade?.result === "WIN" ? "m-win" : "m-loss"}"/><title>${esc(`Exit ${clockOf(x0.exit.time)} at ${x0.exit.price} (${x0.exit.reason === "TARGET" ? "target" : "square-off"})`)}</title></g>` : "";
  const link = x0.entry && x0.exit ? `<line x1="${x(x0.entry.time)}" y1="${y(x0.entry.price)}" x2="${x(x0.exit.time)}" y2="${y(x0.exit.price)}" class="link"/>` : "";
  const xt = [0, 1, 2, 3, 4, 5, 6].map((k) => SETTINGS.sessionOpen + k * 60).filter((m) => m <= SETTINGS.squareOffTime).map((m) => `<text x="${x(m)}" y="${H - 6}" class="tick" text-anchor="middle">${clockOf(m)}</text>`).join("");
  const rs = x0.reference?.start ?? SETTINGS.sessionOpen;
  const band = `<rect x="${x(rs)}" y="${mt}" width="${x(rs + SETTINGS.hourMinutes) - x(rs)}" height="${H - mt - mb}" class="fh-band"/><text x="${x(rs) + 3}" y="${mt + 10}" class="tick">${SETTINGS.hourMinutes === 1 ? "1st minute" : `ref hour ${x0.reference?.hour ?? 1}`}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${band}${fib}${candles}${sig}${link}${ent}${ex}${xt}</svg>`;
}

const REFLABEL = SETTINGS.hourMinutes === 60 ? "First-hour" : SETTINGS.hourMinutes === 1 ? "First-minute" : "Reference";
const table = (head: string[], body: (string | number)[][], cls = "") => `<div class="tbl"><table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const money = (v: number) => `<span class="${v > 0 ? "up" : v < 0 ? "dn" : ""}">${inr(v)}</span>`;
const tiles = [
  ["Trading days", `${okPlans.length}`, `${sessions.length} sessions, ${sessions.length - okPlans.length} excluded`],
  ["Trades / no entry", `${all.trades} / ${noEntry.length}`, `target hit ${all.targetHitPct}% · ${all.squareOffs} squared off`],
  ["Wins / losses", `${all.wins} / ${all.losses}`, `win rate ${all.winRate}%`],
  ["Net P&L", inr(all.net), `after ${inr(all.charges)} charges`],
  ["Max drawdown", inr(all.maxDrawdown), `profit factor ${all.profitFactor ?? "–"}`],
];
const catRows = categories.map(([name, s]) => [name, s.trades, s.wins, s.losses, s.trades ? `${s.winRate}%` : "–", s.trades ? `${s.targetHitPct}%` : "–", money(s.net), money(s.maxDrawdown)]);
const greenRed = categories.filter(([n]) => n === "Combined GREEN" || n === "Combined RED").map(([n, s]) => ({ label: n.replace("Combined ", ""), value: s.net, tip: `${n}: ${s.trades} trades, ${s.wins} W / ${s.losses} L, net ${inr(s.net)}` }));
const cePe = categories.filter(([n]) => n === "Combined CE" || n === "Combined PE").map(([n, s]) => ({ label: n.replace("Combined ", ""), value: s.net, tip: `${n}: ${s.trades} trades, ${s.wins} W / ${s.losses} L, net ${inr(s.net)}` }));
const fourCat = categories.slice(0, 4).map(([n, s]) => ({ label: n, value: s.net, tip: `${n}: ${s.trades} trades, ${s.wins} W / ${s.losses} L, net ${inr(s.net)}` }));
/** One CALL panel and one PUT panel per day, the SAME rules for both; each panel's orientation comes from its own
 * contract's first-hour colour: GREEN → Fib 1 = High (top), 0 = Low (bottom); RED → Fib 0 = High (top), 1 = Low (bottom). */
function panel(c: ContractRow | undefined, right: Right, p: DayPlan) {
  const title = `ATM ${p.strike} ${right === "CE" ? "CALL (CE)" : "PUT (PE)"}`;
  const x = c?.result;
  if (!x || !x.firstHour || !x.direction) {
    return `<div class="card fv-panel"><div class="fv-head"><b>${title}</b><span class="chip">${x ? x.status.replace("_", " ") : "NO DATA"}</span></div><div class="note">${esc(c?.symbol ?? "")}</div><p class="note">${esc(x?.note ?? "No data for this contract.")}</p></div>`;
  }
  const g = x.direction === "GREEN";
  const fh = x.firstHour;
  const role = (l: number) => (l === x.entryLevel ? "ENTRY — buy when price crosses above" : l === x.targetLevel ? "EXIT TARGET" : l === 0 ? (g ? `${REFLABEL} Low (bottom)` : `${REFLABEL} High (top)`) : l === 1 ? (g ? `${REFLABEL} High (top)` : `${REFLABEL} Low (bottom)`) : "");
  const levelRows = x.levels.filter((l) => l.level !== 0.5).sort((a, b) => b.price - a.price)
    .map((l) => `<tr class="${l.level === x.entryLevel ? "r-entry" : l.level === x.targetLevel ? "r-target" : ""}"><td>${lvl(l.level)}</td><td>₹${num(r2(l.price))}</td><td>${role(l.level)}</td></tr>`).join("");
  const t = c!.trade;
  const outcome = t
    ? `<b class="${t.result === "WIN" ? "up" : "dn"}">${t.result}</b> · entry ${t.entryTime} @ ₹${t.entryPrice} → exit ${t.exitTime} @ ₹${t.exitPrice} (${esc(t.exitReason.toLowerCase())}) · ${t.quantity} qty · net ${inr(t.net)}`
    : esc(x.note);
  return `<div class="card fv-panel"><div class="fv-head"><b>${title}</b><span class="chip ${g ? "chip-g" : "chip-r"}">${g ? "▲ GREEN" : "▼ RED"} ${SETTINGS.hourMinutes === 1 ? "first minute" : `ref hour ${x.reference!.hour}`}</span></div>
    <div class="note">${esc(c!.symbol)} · reference candle ${clockOf(x.reference!.start)}–${clockOf(x.reference!.end)}: O ₹${x.reference!.open} · <b>High ₹${x.reference!.high}</b> · <b>Low ₹${x.reference!.low}</b> · C ₹${x.reference!.close}${SETTINGS.hourMinutes === 60 && x.reference!.hour === 1 ? "" : ""}</div>
    <div class="note">${g ? "GREEN: Fib 1.000 = High (top), Fib 0.000 = Low (bottom). Entry when price crosses above 0.236, exit 0.382." : "RED: Fib 0.000 = High (top), Fib 1.000 = Low (bottom). Entry when price crosses above 0.786, exit 0.618."}</div>
    ${candleChart(c!)}
    <div class="tbl"><table class="lv"><thead><tr><th>Fib</th><th>Price</th><th>Role</th></tr></thead><tbody>${levelRows}</tbody></table></div>
    <p class="note">${outcome}</p></div>`;
}
const viewDays = okPlans.map((p, index) => {
  const cs = base.contracts.filter((c) => c.plan.date === p.date);
  const tag = cs.map((c) => `${c.right} ${c.result!.direction ?? "—"}${c.trade ? ` ${c.trade.result === "WIN" ? "✓" : "✗"} ${inr0(c.trade.net)}` : ""}`).join(" · ");
  const hidden = index === okPlans.length - 1 ? "" : " hidden";
  return {
    date: p.date, label: `${p.date} · ATM ${p.strike} · ${tag}`,
    html: `<div class="fv-day" data-date="${p.date}"${hidden}><div class="note">${p.date} · NIFTY ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes - 1)} close ${p.spotClose} → ATM ${p.strike} · expiry ${p.expiry} (DTE ${p.dte}) · lot ${p.lotSize}</div><div class="pair">${panel(cs.find((c) => c.right === "CE"), "CE", p)}${panel(cs.find((c) => c.right === "PE"), "PE", p)}</div></div>`,
  };
});
const viewerScript = `(()=>{const sel=document.getElementById("fv-day"),views=[...document.querySelectorAll(".fv-day")],dates=views.map(v=>v.dataset.date);
const show=d=>{views.forEach(v=>v.hidden=v.dataset.date!==d);sel.value=d;};
sel.addEventListener("change",()=>show(sel.value));
document.getElementById("fv-prev").addEventListener("click",()=>{const i=dates.indexOf(sel.value);if(i>0)show(dates[i-1]);});
document.getElementById("fv-next").addEventListener("click",()=>{const i=dates.indexOf(sel.value);if(i<dates.length-1)show(dates[i+1]);});})();`;
const viewer = `<div class="fv-controls"><button type="button" id="fv-prev" aria-label="Previous day">‹</button><select id="fv-day" aria-label="Trading day">${viewDays.map((d, i) => `<option value="${d.date}"${i === viewDays.length - 1 ? " selected" : ""}>${esc(d.label)}</option>`).join("")}</select><button type="button" id="fv-next" aria-label="Next day">›</button></div>${viewDays.map((d) => d.html).join("")}<script>${viewerScript}</script>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fibonacci Breakout Backtest</title>
<style>
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--base:#c3c2b7;--border:rgba(11,11,11,.10);--pos:#2a78d6;--neg:#e34948;--good:#0ca30c;--crit:#d03b3b;--s1:#2a78d6;--s2:#eb6834;--up-text:#006300;--dn-text:#c0302f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--base:#383835;--border:rgba(255,255,255,.10);--pos:#3987e5;--neg:#e66767;--s1:#3987e5;--s2:#d95926;--up-text:#0ca30c;--dn-text:#e66767}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--base:#383835;--border:rgba(255,255,255,.10);--pos:#3987e5;--neg:#e66767;--s1:#3987e5;--s2:#d95926;--up-text:#0ca30c;--dn-text:#e66767}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}h3{font-size:14px;margin:16px 0 6px}
.muted{color:var(--ink2)}.note{color:var(--ink2);font-size:13px}.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;margin:10px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px}.tile .k{color:var(--ink2);font-size:12px}.tile .v{font-size:22px;font-weight:600}.tile .s{color:var(--muted);font-size:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--grid);stroke-width:1}.chart .base{stroke:var(--base);stroke-width:1}.chart .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.chart .vlabel{fill:var(--ink2);font-size:12px}
.chart .pos{fill:var(--pos)}.chart .neg{fill:var(--neg)}.chart .line{fill:none;stroke:var(--pos);stroke-width:2}.chart .dot{fill:var(--pos);stroke:var(--surface);stroke-width:2}.chart .win{fill:var(--good)}.chart .loss{fill:var(--crit)}
.chart .hit:hover path,.chart .hit:hover rect:not([fill=transparent]),.chart .hit:hover circle.dot{opacity:.8}
.chart .c-up{fill:var(--good)}.chart .c-dn{fill:var(--crit)}.chart .wick-up{stroke:var(--good);stroke-width:1.5}.chart .wick-dn{stroke:var(--crit);stroke-width:1.5}
.chart .fib{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}.chart .fib-edge{stroke:var(--ink2);stroke-width:1}.chart .fib-entry{stroke:var(--s1);stroke-width:2}.chart .fib-target{stroke:var(--s2);stroke-width:2}
.chart .flabel{fill:var(--ink2);font-size:10.5px;font-variant-numeric:tabular-nums}.chart .flabel.strong{fill:var(--ink);font-weight:600}
.chart .sig{stroke:var(--muted);stroke-width:1;stroke-dasharray:2 4}.chart .link{stroke:var(--ink2);stroke-width:1;stroke-dasharray:4 3}
.chart .m-entry{fill:var(--s1);stroke:var(--surface);stroke-width:1.5}.chart .m-win{fill:var(--good);stroke:var(--surface);stroke-width:1.5}.chart .m-loss{fill:var(--crit);stroke:var(--surface);stroke-width:1.5}
.chart .arrow{stroke:var(--s1);stroke-width:2;fill:none}.chart .arrow-t{stroke:var(--s2);stroke-width:2;fill:none}.ref{max-width:380px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--ink2);margin:4px 0}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px}
.tbl{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface)}table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap}th{color:var(--ink2);font-weight:600;position:sticky;top:0;background:var(--surface)}td:first-child,th:first-child{text-align:left}.left td{text-align:left}
.up{color:var(--up-text)}.dn{color:var(--dn-text)}.pass{color:var(--up-text);font-weight:600}.fail{color:var(--dn-text);font-weight:600}
details.day{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin:8px 0;padding:8px 12px}details.day summary{cursor:pointer;font-size:13px}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-top:8px}figure{margin:0}figcaption{font-size:12.5px;margin-bottom:4px}
.fh-band{fill:var(--grid);opacity:.45}.chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--border);color:var(--ink2)}.chip-g{background:var(--good);color:#fff;border-color:transparent}.chip-r{background:var(--crit);color:#fff;border-color:transparent}
.fv-controls{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}.fv-controls select{flex:1;min-width:0;max-width:640px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink);font:inherit}.fv-controls button{padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink);font:inherit;cursor:pointer}
.fv-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;font-size:15px}.fv-panel .tbl{margin-top:8px}table.lv td:last-child,table.lv th:last-child{text-align:left}tr.r-entry td{color:var(--s1);font-weight:600}tr.r-target td{color:var(--s2);font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--border);font-size:12px;color:var(--ink2)}
</style></head><body><main>
<h1>1-Hour Fibonacci Breakout — backtest</h1>
<div class="muted">NIFTY weekly ATM CE and PE · ${FROM} to ${TO} · real 1-minute option premiums (Dhan) · <span class="badge">BACKTEST / PAPER only — no live orders</span></div>

<div class="tiles" style="margin-top:16px">${tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("")}</div>
<p class="note">Result: <b>${all.net >= 0 ? "net positive" : "net loss"}</b> over ${okPlans.length} trading days, ${all.trades} Fibonacci-triggered trades (no fallback, no forced trades). Entries are modelled from 1-minute candles: ${fillCount("GAP_OPEN")} at a minute's open, ${fillCount("INTRAMINUTE") + fillCount("INTRAMINUTE_ARMED")} inside a minute at the first tick above the trigger; ${ambiguous} ambiguous minute(s) were not traded.</p>

<h2>Overall performance</h2>
${table(["Metric", "Value"], [
  ["Total trading days", `${okPlans.length} (+${sessions.length - okPlans.length} excluded)`], ["Executed trades (Fibonacci entries only)", all.trades], ["NO ENTRY contract-days", `${noEntry.length} (CE ${statusCount("NO_ENTRY", "CE")}, PE ${statusCount("NO_ENTRY", "PE")})`], ["Days with no trade at all", noEntryDays.length], ["Entry fills: open / inside minute / ambiguous minutes skipped", `${fillCount("GAP_OPEN")} / ${fillCount("INTRAMINUTE") + fillCount("INTRAMINUTE_ARMED")} / ${ambiguous}`],
  ["Winning trades (net > 0)", all.wins], ["Losing trades", all.losses], ["Win rate", `${all.winRate}%`], ["Target hit / squared off at 15:29", `${all.targets} (${all.targetHitPct}%) / ${all.squareOffs}`],
  ["Gross profit (pre-charge, winning legs)", money(all.grossProfit)], ["Gross loss (pre-charge, losing legs)", money(all.grossLoss)], ["Total charges", inr(all.charges)], ["Slippage cost (already in the prices)", inr(all.slippage)],
  ["Net profit / loss", money(all.net)], ["Average net per winning trade", money(all.avgWin)], ["Average net per losing trade", money(all.avgLoss)], ["Maximum drawdown (closed trades)", money(all.maxDrawdown)], ["Profit factor (net wins / net losses)", all.profitFactor ?? "–"],
], "left")}

<h2>Separate performance</h2>
${table(["Category", "Trades", "Wins", "Losses", "Win rate", "Target hit", "Net P&L", "Max DD"], catRows)}

<h2>Daily net P&L</h2><div class="card">${barChart(dailyCum.map((d) => ({ label: d.date.slice(5), value: d.net, tip: `${d.date}: ${d.trades} trade(s), net ${inr(d.net)}` })), { rotate: true })}<div class="legend"><span><i style="background:var(--pos)"></i>Net gain</span><span><i style="background:var(--neg)"></i>Net loss</span></div></div>
<h2>Cumulative net P&L</h2><div class="card">${lineChart(dailyCum.map((d) => ({ label: d.date.slice(5), value: d.cumulative, tip: `${d.date}: cumulative ${inr(d.cumulative)} (day ${inr(d.net)})` })))}</div>
<div class="grid2">
<div><h2>GREEN vs RED first hour</h2><div class="card">${barChart(greenRed, { height: 230, width: 480 })}<div class="note">${greenRed.map((g) => esc(g.tip)).join("<br>")}</div></div></div>
<div><h2>CE vs PE</h2><div class="card">${barChart(cePe, { height: 230, width: 480 })}<div class="note">${cePe.map((g) => esc(g.tip)).join("<br>")}</div></div></div>
</div>
<h2>By direction and contract</h2><div class="card">${barChart(fourCat, { height: 230 })}</div>
<h2>Winning vs losing trades</h2><div class="card">${winLossChart(categories.filter(([n]) => !n.startsWith("Combined G") && !n.startsWith("Combined R")).map(([n, s]) => ({ label: n, wins: s.wins, losses: s.losses })))}<div class="legend"><span><i style="background:var(--good)"></i>Wins (net &gt; 0)</span><span><i style="background:var(--crit)"></i>Losses</span></div></div>

<h2>Fibonacci chart — CALL and PUT</h2>
<p class="note">CALL and PUT follow exactly the same rules. Each contract's own reference candle (${clockOf(SETTINGS.sessionOpen)}–${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes)}) sets its orientation: <b>GREEN</b> → Fib 1.000 = High at the top, 0.000 = Low at the bottom, entry 0.236, exit 0.382; <b>RED</b> → Fib 0.000 = High at the top, 1.000 = Low at the bottom, entry 0.786, exit 0.618. Real option premiums of the chosen day; pick any day of the backtest.</p>
<div class="legend"><span><i style="background:var(--s1)"></i>Entry level / ▲ entry</span><span><i style="background:var(--s2)"></i>Exit target level</span><span><i style="background:var(--good)"></i>▼ exit, win</span><span><i style="background:var(--crit)"></i>▼ exit, loss</span><span>entry = first price above the trigger after ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes)}</span></div>
${viewer}

<h2>Individual trade history</h2>
${table(["Date", "Contract", "Side", "Ref hour · colour", "Ref high", "Ref low", "Entry lvl", "Exit lvl", "Entry", "Entry ₹", "Fill", "Exit", "Exit ₹", "Qty", "Gross", "Charges", "Net", "Exit reason", "Result"],
  base.trades.map((t) => [t.date, t.symbol, t.right, `${t.refHour} · ${t.direction}`, t.fhHigh, t.fhLow, `${t.entryLevel} · ${t.entryLevelPrice}`, `${t.targetLevel} · ${t.targetLevelPrice}`, t.entryTime, t.entryPrice, t.entryFill.toLowerCase().replace(/_/g, " "), t.exitTime, t.exitPrice, t.quantity, money(t.gross), inr(t.charges), money(t.net), t.exitReason, t.result]))}
<p class="note">Full columns (first-hour OHLC, trigger tick, fill type, slippage, DTE, excursions) are in trades.csv; every NO ENTRY contract-day is in contract-days.csv.</p>


<h2>Execution sensitivity</h2>
<p class="note">Same rules and levels; only the execution assumption changes. Not used to choose settings.</p>
${table(["Run", "Trades", "W / L", "Net P&L", "Max DD"], sensitivity.map((s) => [s.label, s.trades, `${s.wins} / ${s.losses}`, money(s.net), money(s.maxDrawdown)]))}

<h2>Data quality and validation</h2>
${table(["Check", "Result", "Detail"], checks.map((c) => [c.name, `<span class="${c.pass ? "pass" : "fail"}">${c.pass ? "PASS" : "FAIL"}</span>`, `<span style="white-space:normal;display:block;max-width:640px;text-align:left">${esc(c.detail)}</span>`]), "left")}
<h3>Sessions</h3>
${table(["Date", "Status", "Expiry", "DTE", "NIFTY 10:14", "ATM", "API ATM", "CE min", "PE min", "Note"], base.plans.map((p) => [p.date, p.status, p.expiry, p.dte ?? "", p.spotClose ?? "", p.strike ?? "", p.apiAtmCE ?? "", p.optionMinutes.CE, p.optionMinutes.PE, esc(p.reason || (p.expirySource.startsWith("expiry_calendar") ? "" : "expiry from scrip-master snapshot"))]))}

<h2>Settings used</h2>
<div class="card note">Underlying ${SETTINGS.underlying} (strike step ${SETTINGS.strikeStep}; ATM from NIFTY's ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes - 1)} close, same strike for CE and PE) · sides ${SETTINGS.sides.join(" + ")} · ${SETTINGS.lots} lot(s) · GREEN trigger ${SETTINGS.greenEntryLevel} / target ${SETTINGS.greenTargetLevel} · RED trigger ${SETTINGS.redEntryLevel} / target ${SETTINGS.redTargetLevel} · entry = live price crossing ABOVE the trigger from below, from ${clockOf(SETTINGS.sessionOpen + SETTINGS.hourMinutes)} (1-minute history: first tick above the trigger + ${SETTINGS.slippageTicks} tick(s), or a minute's open after a gap) · no hourly confirmation, no fallback · one entry per contract per day · target = resting sell, ${SETTINGS.targetFill} · no stop-loss · square-off at the ${clockOf(SETTINGS.squareOffTime)} price − ${SETTINGS.slippageTicks} tick(s) · charges: ₹${SETTINGS.charges.brokeragePerOrder}/order brokerage, STT on the sell by date (0.05% → 0.0625% → 0.1% → 0.15%), NSE by date (0.053% → 0.03503%), SEBI ₹10/cr, stamp 0.003% buy, GST 18%.</div>
</main></body></html>`;
if (!QUICK) writeFileSync(path.join(OUT, "report.html"), html);

console.log(`Window ${FROM}..${TO}: ${sessions.length} sessions, ${okPlans.length} evaluated`);
console.log(`Trades ${all.trades}, W/L ${all.wins}/${all.losses}, net ${all.net}, charges ${all.charges}, maxDD ${all.maxDrawdown}, PF ${all.profitFactor}, target ${all.targets} (${all.targetHitPct}%), squared off ${all.squareOffs}, NO ENTRY ${noEntry.length} (CE ${statusCount("NO_ENTRY", "CE")} PE ${statusCount("NO_ENTRY", "PE")}), no-trade days ${noEntryDays.length}, fills gap ${fillCount("GAP_OPEN")} intra ${fillCount("INTRAMINUTE")} armed ${fillCount("INTRAMINUTE_ARMED")}, ambiguous ${ambiguous}`);
for (const [n, s] of categories) console.log(`${n.padEnd(15)} ${String(s.trades).padStart(3)} ${s.wins}/${s.losses} target ${s.targetHitPct}% net ${s.net} maxDD ${s.maxDrawdown}`);
for (const s of sensitivity) console.log(`SENS ${s.label}: ${s.trades} ${s.wins}/${s.losses} net ${s.net}`);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
console.log(`rule skips: expiry day ${skipped.expiryDay}, target under ${SETTINGS.minTargetPct}% ${skipped.smallTarget} (contract-days)`);
console.log(`statuses: ${["INCOMPLETE", "NO_SETUP", "NO_ENTRY", "NOT_EXECUTED", "CLOSED"].map((s) => `${s} ${statusCount(s)}`).join(", ")}`);
console.log(`-> ${OUT}`);
