/**
 * Automated paper trading: the 8 strategies' ENTRY rules, ported one-to-one from the research scripts that produced
 * their 5-year backtests (D:/TRADING). Pure (no I/O); every function reads only the 1-minute candles it is given,
 * so the engine passes completed candles only and nothing can look ahead.
 *
 *  Mathi Second Hour (+ Tue / Thu / Tue+Thu copies) and Mathi Hourly Breakout FINAL
 *      PROJECT_NEXUS/MATHI_SECOND_HOUR (and its _TUESDAY, _THURSDAY, _TUE_THU copies)  (FINAL = --one-trade --no-gapdown --no-wedmom)
 *      Plan F signal: MATHI_HOURLY_OPTIMIZATION/scripts/opt_engine.py f_signal, body_break, hour_levels, decide
 *  Mathi 13:15 Minute v2 / v3
 *      PROJECT_NEXUS/MATHI_1315_MINUTE/FIXED_v2_2026-11-19 and FIXED_v3_2026-11-19/mathi_1315_minute.py
 *  MonWed (frozen rules, fixed +1.48%)
 *      NIFTY_HOURLY_ATM_CE_2PT/monwed.py  (--exit=fixed, --lowvix=skip, every filter on)
 *
 * Minutes are IST minutes of the day (09:15 = 555); a candle at minute m is complete at m + 1.
 */

export type Bar = { o: number; h: number; l: number; c: number; v?: number };
/** Completed 1-minute candles of one session by IST minute. */
export type Minutes = Map<number, Bar>;
export type Side = "CALL" | "PUT";
export type Right = "CE" | "PE";
export type Signal = { side: Side; level: number; brk: number; conf: number; firstClose: number; confClose: number };

export const OPEN = 555;
export const C2S = 615;
export const C2E = 675;
export const SQ = 920; // 15:20
export const TICK = 0.05;
export const FIRST_HOUR_MAX = 108.8;
export const FLIP_TINY = 1.4;
export const MOMENTUM = 16.2;
export const GAP_MIN = -0.5;

export const r2 = (value: number) => Math.floor(value * 100 + 0.5) / 100;
export const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const strikeOf = (spot: number) => Math.floor(spot / 50 + 0.5) * 50;

/** body_break: points of the 20% body beyond the level, or null. */
export function bodyBreak(c: Bar, side: Side, level: number, share = 0.2): number | null {
  const body = Math.abs(c.c - c.o);
  if (!(body > 0)) return null;
  const beyond = side === "CALL" ? c.c - Math.max(c.o, level) : Math.min(c.o, level) - c.c;
  const closed = side === "CALL" ? c.c > level : c.c < level;
  if (!closed || !(beyond > 0) || beyond < body * share - 1e-9) return null;
  return beyond;
}

/** hour_levels: the high and low of the hour starting at `start`, only when all 60 minutes are present. */
export function hourLevels(n: Minutes, start: number): { CALL: number; PUT: number } | null {
  let hi = -Infinity;
  let lo = Infinity;
  for (let m = start; m < start + 60; m += 1) {
    const bar = n.get(m);
    if (!bar) return null;
    hi = Math.max(hi, bar.h);
    lo = Math.min(lo, bar.l);
  }
  return { CALL: hi, PUT: lo };
}

/**
 * Plan F (opt_engine.f_signal): from 11:15, the previous full hour's high / low (rolling each hour). A 20% body break is
 * a candidate; the next candle closing beyond the line confirms it. While waiting, a 20% break of the other line
 * switches the candidate, a strong close back inside cancels it (that candle may start a new one), a weak close inside
 * is tolerated. `cutoff`: only candles with m + 1 <= cutoff are read. A missing hour ends the search (no signal).
 */
export function planF(n: Minutes, fromMin = C2E, cutoff = 14 * 60 + 15): Signal | null {
  let cand: { side: Side; level: number; brk: number; firstClose: number } | null = null;
  let start = -1;
  let levels: { CALL: number; PUT: number } | null = null;
  const minutes = [...n.keys()].filter((m) => m >= Math.max(fromMin, C2E) && m + 1 <= cutoff).sort((a, b) => a - b);
  for (const m of minutes) {
    const hs = C2S + Math.floor((m - C2E) / 60) * 60;
    if (hs !== start) {
      levels = hourLevels(n, hs);
      if (!levels) return null;
      start = hs;
    }
    const lv = levels!;
    const c = n.get(m)!;
    if (cand) {
      const beyond = cand.side === "CALL" ? c.c > cand.level : c.c < cand.level;
      if (beyond) return { side: cand.side, level: cand.level, brk: cand.brk, conf: m, firstClose: cand.firstClose, confClose: c.c };
      const other: Side = cand.side === "CALL" ? "PUT" : "CALL";
      if (bodyBreak(c, other, lv[other]) != null) {
        cand = { side: other, level: lv[other], brk: m, firstClose: c.c };
        continue;
      }
      if (bodyBreak(c, other, cand.level) != null) cand = null;
      else continue;
    }
    for (const side of ["CALL", "PUT"] as const) {
      if (bodyBreak(c, side, lv[side]) != null) {
        cand = { side, level: lv[side], brk: m, firstClose: c.c };
        break;
      }
    }
  }
  return null;
}

/** minute_signal (13:15 Minute): the same candidate rule on the 13:15 candle's high / low, minutes start..last. */
export function minuteSignal(n: Minutes, start: number, last: number, accept?: (s: Signal) => boolean, lineMinute = 795): Signal | null {
  const line = n.get(lineMinute);
  if (!line) return null;
  const lv = { CALL: line.h, PUT: line.l };
  let cand: { side: Side; level: number; brk: number } | null = null;
  for (let m = start; m <= last; m += 1) {
    const c = n.get(m);
    if (!c) continue;
    if (cand) {
      if (cand.side === "CALL" ? c.c > cand.level : c.c < cand.level) {
        const sig: Signal = { side: cand.side, level: cand.level, brk: cand.brk, conf: m, firstClose: cand.level + (cand.side === "CALL" ? 10 : -10), confClose: c.c };
        if (!accept || accept(sig)) return sig;
        cand = null;
        continue;
      }
      const other: Side = cand.side === "CALL" ? "PUT" : "CALL";
      if (bodyBreak(c, other, lv[other]) != null) {
        cand = { side: other, level: lv[other], brk: m };
        continue;
      }
      if (bodyBreak(c, other, cand.level) != null) cand = null;
      else continue;
    }
    for (const side of ["CALL", "PUT"] as const) {
      if (bodyBreak(c, side, lv[side]) != null) {
        cand = { side, level: lv[side], brk: m };
        break;
      }
    }
  }
  return null;
}

/** decide: the option bought; flip tiny buys the opposite one when the breakout candle closed < 1.4 pts past the line. */
export function decide(sig: Signal, flipTiny = true): { right: Right; flip: boolean } {
  const past = sig.side === "CALL" ? sig.firstClose - sig.level : sig.level - sig.firstClose;
  const flip = flipTiny && past < FLIP_TINY;
  return { right: (sig.side === "CALL") !== flip ? "CE" : "PE", flip };
}

/** features().mom15: NIFTY's move in the trade's direction, confirmation close vs the close 15 minutes earlier. */
export function momentum15(n: Minutes, sig: Signal) {
  const before = n.get(sig.conf - 15);
  return before ? (sig.side === "CALL" ? 1 : -1) * (sig.confClose - before.c) : 0;
}

/** First-hour (09:15–10:14) range, or null before any of its candles. */
export function firstHourRange(n: Minutes) {
  let hi = -Infinity;
  let lo = Infinity;
  for (let m = OPEN; m < C2S; m += 1) {
    const bar = n.get(m);
    if (bar) { hi = Math.max(hi, bar.h); lo = Math.min(lo, bar.l); }
  }
  return Number.isFinite(hi) ? hi - lo : null;
}

/** vix_at: India VIX close at minute m, else m − 1, else m − 2. */
export function vixAt(vix: Map<number, number>, m: number): number | null {
  return vix.get(m) ?? vix.get(m - 1) ?? vix.get(m - 2) ?? null;
}

export type WeekdayName = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export const weekdayOf = (date: string): WeekdayName => (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const)[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** What a strategy decided for the next trade, as known from the candles given. */
export type Decision =
  | { kind: "WAIT"; note: string }
  | { kind: "SKIP"; reason: string }
  | { kind: "SIGNAL"; sig: Signal; right: Right; flip: boolean; strike: number; maxBuy?: number; vix: number | null; note: string };

// ─────────────────────────────── Mathi Second Hour family ───────────────────────────────

export type SecondHourParams = { onlyDays: WeekdayName[] | null; oneTrade: boolean; allowGapDown: boolean; wedMomentum: boolean };
export const LAST_CONF = 12 * 60 + 10;
export const T2_CUT = 13 * 60 + 10;

/** The day's context the rules need besides the candles. */
export type DayContext = { date: string; prevClose: number | null; daysToExpiry: number | null };

/** Day-level checks known before 11:15 (mathi_second_hour.py order). Null = may trade; `extra` = trade 1 only. */
export function secondHourDay(n: Minutes, ctx: DayContext, p: SecondHourParams): { skip: string | null; extra: string | null; gap: number; range: number | null } {
  const day = weekdayOf(ctx.date);
  const range = firstHourRange(n);
  const open = n.get(OPEN)?.o;
  const gap = open != null && ctx.prevClose ? (open / ctx.prevClose - 1) * 100 : 0;
  if (p.onlyDays && !p.onlyDays.includes(day)) return { skip: `not a trading day for this strategy (${p.onlyDays.join("/")} only)`, extra: null, gap, range };
  if (range != null && range >= FIRST_HOUR_MAX) return { skip: `first-hour range ${range.toFixed(1)} pts >= ${FIRST_HOUR_MAX}`, extra: null, gap, range };
  if (day === "Wed" && !(p.wedMomentum && gap > GAP_MIN)) return { skip: "Wednesday", extra: null, gap, range };
  if (gap <= GAP_MIN && !(p.allowGapDown && day !== "Wed")) return { skip: `gap down ${gap.toFixed(2)}%`, extra: null, gap, range };
  return { skip: null, extra: day === "Wed" ? "Wednesday + momentum" : gap <= GAP_MIN ? "gap-down day" : null, gap, range };
}

/**
 * Trade 1 (11:16–12:10) or, with `afterExit` (trade 1's exit minute), trade 2 (confirmation by 13:10, 16.2-pt momentum,
 * not on expiry day, not on Wednesday / gap-down days, not for one-trade strategies). `now` = the first minute not yet
 * complete: the decision is WAIT until the rules could still change.
 */
export function secondHourDecision(n: Minutes, ctx: DayContext, p: SecondHourParams, now: number, afterExit: number | null = null): Decision {
  if (now < C2E + 1) return { kind: "WAIT", note: "Waiting for the 10:15–11:15 candle." };
  const day = secondHourDay(n, ctx, p);
  if (day.skip) return { kind: "SKIP", reason: day.skip };
  if (afterExit == null) {
    const sig = planF(n);
    if (!sig) return now > LAST_CONF + 1 ? { kind: "SKIP", reason: "no breakout signal by 12:10" } : { kind: "WAIT", note: "Watching the 10:15–11:15 high / low (11:16–12:10)." };
    if (sig.conf > LAST_CONF) return { kind: "SKIP", reason: `breakout confirmed at ${clock(sig.conf)} (after 12:10)` };
    if (day.extra === "Wednesday + momentum" && momentum15(n, sig) < MOMENTUM) return { kind: "SKIP", reason: `Wednesday (momentum ${momentum15(n, sig).toFixed(1)} < ${MOMENTUM} pts)` };
    const { right, flip } = decide(sig);
    return { kind: "SIGNAL", sig, right, flip, strike: strikeOf(sig.confClose), vix: null, note: `Trade 1${day.extra ? ` (${day.extra})` : ""}` };
  }
  if (p.oneTrade || day.extra || afterExit + 1 > T2_CUT || ctx.daysToExpiry === 0) {
    return { kind: "SKIP", reason: p.oneTrade ? "one trade a day" : day.extra ? `${day.extra}: trade 1 only` : ctx.daysToExpiry === 0 ? "no trade 2 on expiry day" : "trade 1 exited after 13:10" };
  }
  const sig = planF(n, afterExit + 1, T2_CUT + 1);
  if (!sig) return now > T2_CUT + 1 ? { kind: "SKIP", reason: "no trade-2 breakout by 13:10" } : { kind: "WAIT", note: "Watching for trade 2 (until 13:10)." };
  if (sig.conf > T2_CUT || sig.conf <= afterExit) return { kind: "SKIP", reason: "no trade-2 breakout by 13:10" };
  const mom = momentum15(n, sig);
  if (mom < MOMENTUM) return { kind: "SKIP", reason: `trade 2 momentum ${mom.toFixed(1)} < ${MOMENTUM} pts` };
  const { right, flip } = decide(sig);
  return { kind: "SIGNAL", sig, right, flip, strike: strikeOf(sig.confClose), vix: null, note: "Trade 2" };
}

// ─────────────────────────────── Mathi 13:15 Minute v2 / v3 ───────────────────────────────

export type M1315Params = { version: 2 | 3 };
const M1315 = {
  2: { vixMin: 12.5, last: 13 * 60 + 25, ruleA: false, ruleB: false },
  3: { vixMin: 12.0, last: 13 * 60 + 45, ruleA: true, ruleB: true },
} as const;
export const M1315_T2_LAST = 13 * 60 + 45;
export const M1315_T2_MAXBUY = 85;

export function m1315Decision(n: Minutes, vix: Map<number, number>, ctx: DayContext, p: M1315Params, now: number, afterExit: number | null = null): Decision {
  const cfg = M1315[p.version];
  if (now < 796) return { kind: "WAIT", note: "Waiting for the 13:15 candle." };
  const range = firstHourRange(n);
  if (range != null && range >= FIRST_HOUR_MAX) return { kind: "SKIP", reason: `first-hour range ${range.toFixed(1)} pts >= ${FIRST_HOUR_MAX}` };
  const open = n.get(OPEN)?.o;
  const dayDir = (s: Signal) => open != null && (s.side === "CALL" ? 1 : -1) * (s.confClose - open) > 0;
  if (afterExit == null) {
    const sig = minuteSignal(n, 796, cfg.last);
    if (!sig) return now > cfg.last + 1 ? { kind: "SKIP", reason: `no confirmed 13:15-candle breakout by ${clock(cfg.last)}` } : { kind: "WAIT", note: `Watching the 13:15 high / low (13:16–${clock(cfg.last)}).` };
    const sd = sig.side === "CALL" ? 1 : -1;
    const dm = open == null ? 0 : sd * (sig.confClose - open);
    const vx = vixAt(vix, sig.conf);
    if (dm <= 0) return { kind: "SKIP", reason: `breakout against the day direction (${dm.toFixed(1)} pts vs 09:15 open)` };
    if (vx != null && vx <= cfg.vixMin) return { kind: "SKIP", reason: `VIX ${vx.toFixed(2)} <= ${cfg.vixMin}` };
    if (cfg.ruleA && vx != null && vx <= 12.5 && sd * (sig.confClose - sig.level) < 4) return { kind: "SKIP", reason: `rule A: VIX ${vx.toFixed(2)} and only ${(sd * (sig.confClose - sig.level)).toFixed(1)} pts past the line` };
    if (cfg.ruleB && weekdayOf(ctx.date) === "Wed" && ((vx != null && vx <= 12.5) || sig.conf > 13 * 60 + 25)) return { kind: "SKIP", reason: "rule B: Wednesday needs VIX > 12.5 and a buy by 13:25" };
    return { kind: "SIGNAL", sig, right: sig.side === "CALL" ? "CE" : "PE", flip: false, strike: strikeOf(sig.confClose), vix: vx, note: "Trade 1" };
  }
  if (afterExit + 1 > M1315_T2_LAST) return { kind: "SKIP", reason: "trade 1 exited after 13:45" };
  const ok = (s: Signal) => dayDir(s) && !((vixAt(vix, s.conf) ?? 99) <= cfg.vixMin);
  const sig = minuteSignal(n, afterExit + 1, M1315_T2_LAST, ok);
  if (!sig) return now > M1315_T2_LAST + 1 ? { kind: "SKIP", reason: "no trade-2 breakout by 13:45" } : { kind: "WAIT", note: "Watching for trade 2 (until 13:45)." };
  return { kind: "SIGNAL", sig, right: sig.side === "CALL" ? "CE" : "PE", flip: false, strike: strikeOf(sig.confClose), maxBuy: M1315_T2_MAXBUY, vix: vixAt(vix, sig.conf), note: "Trade 2" };
}

// ─────────────────────────────── MonWed ───────────────────────────────

export const MONWED_BUY = 10 * 60 + 15;
export const MONWED_TARGET = 0.0148;
const GAP_PUT = -0.25;
const WEAK = 0.2;
const VIX_MAX = 12.5;

/** Event calendar context: the dates MonWed does not trade, with their names (from monwed.py event_days()). */
export type MonWedCalendar = { niftyExpiry: boolean; sensexExpiry: boolean; event: string | null };

export type MonWedPlan = { right: Right; strike: number; weak: boolean; gap: number; vix: number | null; firstHourPosition: number | null; close: number };

/** monwed.py main(): skip reasons in the script's order, else the side / strike / weak flag at 10:15. */
export function monwedDecision(n: Minutes, vix: Map<number, number>, ctx: DayContext, cal: MonWedCalendar, now: number): { kind: "WAIT"; note: string } | { kind: "SKIP"; reason: string } | { kind: "PLAN"; plan: MonWedPlan } {
  if (now < MONWED_BUY) return { kind: "WAIT", note: "Waiting for 10:15." };
  const first = [...n.entries()].filter(([m]) => m < MONWED_BUY).sort((a, b) => a[0] - b[0]);
  if (!first.length || first.at(-1)![0] !== MONWED_BUY - 1) return { kind: "SKIP", reason: "the 10:14 candle is missing" };
  const o = first[0][1].o;
  const h = Math.max(...first.map(([, b]) => b.h));
  const l = Math.min(...first.map(([, b]) => b.l));
  const c = first.at(-1)![1].c;
  const gap = ctx.prevClose ? (o / ctx.prevClose - 1) * 100 : 0;
  const vx = vix.get(MONWED_BUY - 1) ?? null;
  const day = weekdayOf(ctx.date);
  const low = vx != null && vx <= VIX_MAX;
  let why: string | null = null;
  if (cal.niftyExpiry || cal.sensexExpiry) why = cal.niftyExpiry && cal.sensexExpiry ? "NIFTY + SENSEX expiry" : cal.niftyExpiry ? "NIFTY expiry" : "SENSEX expiry";
  else if (cal.event) why = `Event: ${cal.event}`;
  else if (day === "Tue") why = "Tuesday";
  else if (day === "Fri") why = "Friday";
  else if (low) why = `Low VIX ${vx!.toFixed(1)}`;
  else if (gap <= GAP_PUT && c > o) why = "Gap-down recovered";
  else if (Number(ctx.date.slice(5, 7)) === 12 && Number(ctx.date.slice(8, 10)) >= 24) why = "Year-end holiday week";
  if (why) return { kind: "SKIP", reason: why };
  const right: Right = gap <= GAP_PUT ? "PE" : "CE";
  const rng = h - l;
  const pos = rng > 0 ? (c - l) / rng : null;
  const weak = pos != null && (right === "CE" ? pos <= WEAK : pos >= 1 - WEAK);
  return { kind: "PLAN", plan: { right, strike: strikeOf(c), weak, gap, vix: vx, firstHourPosition: pos, close: c } };
}

/** SENSEX weekly expiry by the exchange rule (monwed.py sensex_expiries); `tradingDays` must cover that week. */
export function sensexExpiry(date: string, isTradingDay: (day: string) => boolean): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  if (iso(monday) < "2023-05-09") return false;
  const wd = iso(monday) < "2024-12-26" ? 4 : iso(monday) < "2025-08-26" ? 1 : 3;
  const expiry = new Date(monday);
  expiry.setUTCDate(monday.getUTCDate() + wd);
  if (iso(expiry) < "2023-05-15") return false;
  while (expiry >= monday && !isTradingDay(iso(expiry))) expiry.setUTCDate(expiry.getUTCDate() - 1);
  return expiry >= monday && iso(expiry) === date;
}

/** event_days(): RBI, election, Budget, US-tariff dates, and the FOMC window (decision − 2 days .. decision, + next session). */
export function eventOn(date: string, lists: { rbi: string[]; election: string[]; budget: string[]; tariff: string[]; fomc: string[] }, sessionsAfter: (day: string) => string | null): string | null {
  const names: string[] = [];
  if (lists.rbi.includes(date)) names.push("RBI policy");
  if (lists.election.includes(date)) names.push("Election");
  if (lists.budget.includes(date)) names.push("Budget");
  if (lists.tariff.includes(date)) names.push("US tariff");
  for (const decision of lists.fomc) {
    const from = new Date(`${decision}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 2);
    if (date >= from.toISOString().slice(0, 10) && date <= decision) names.push("Fed week");
    if (sessionsAfter(decision) === date) names.push("Fed reaction");
  }
  return names.length ? names.join("+") : null;
}
