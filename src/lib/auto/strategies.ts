/**
 * The 8 automated paper strategies: which ported rule set each runs, its trade limits and its BACKTEST record
 * (5 years, Nov 2021 – Nov 2026, from the research trade lists; shown as backtest, never mixed with live paper results).
 */
import type { M1315Params, SecondHourParams, WeekdayName } from "./rules";

export type AutoStrategyKey = "SH_TUE_THU" | "M1315_V3" | "SH_THU" | "SH_TUE" | "M1315_V2" | "SH_ALL" | "MHB_FINAL" | "MONWED";

export type AutoStrategyDef = {
  key: AutoStrategyKey;
  name: string;
  family: "second_hour" | "m1315" | "monwed";
  secondHour?: SecondHourParams;
  m1315?: M1315Params;
  maxTrades: number;
  /** Trade-2 lock (+%) until the trail starts. */
  lockPct: number | null;
  days: WeekdayName[];
  window: string;
  exit: string;
  backtest: { trades: number; wins: number; losses: number; source: string };
};

const SH = (onlyDays: WeekdayName[] | null): SecondHourParams => ({ onlyDays, oneTrade: false, allowGapDown: true, wedMomentum: true });
const TRAIL = "Trail starts at the lower of +2% and +₹2 on the premium; stop = highest − 1% of the buy price, never below the start; else 15:20";
const WEEK: WeekdayName[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];

export const AUTO_STRATEGIES: AutoStrategyDef[] = [
  { key: "SH_TUE_THU", name: "Mathi Second Hour Tue+Thu", family: "second_hour", secondHour: SH(["Tue", "Thu"]), maxTrades: 2, lockPct: 0.5, days: ["Tue", "Thu"], window: "11:16–12:10 (trade 2 until 13:10)", exit: TRAIL, backtest: { trades: 228, wins: 228, losses: 0, source: "PROJECT_NEXUS/MATHI_SECOND_HOUR_TUE_THU" } },
  { key: "M1315_V3", name: "Mathi 13:15 Minute v3", family: "m1315", m1315: { version: 3 }, maxTrades: 2, lockPct: 0.7, days: WEEK, window: "13:16–13:45", exit: TRAIL, backtest: { trades: 272, wins: 272, losses: 0, source: "PROJECT_NEXUS/MATHI_1315_MINUTE/FIXED_v3_2026-11-19" } },
  { key: "SH_THU", name: "Mathi Second Hour Thursday", family: "second_hour", secondHour: SH(["Thu"]), maxTrades: 2, lockPct: 0.5, days: ["Thu"], window: "11:16–12:10 (trade 2 until 13:10)", exit: TRAIL, backtest: { trades: 122, wins: 122, losses: 0, source: "PROJECT_NEXUS/MATHI_SECOND_HOUR_THURSDAY" } },
  { key: "SH_TUE", name: "Mathi Second Hour Tuesday", family: "second_hour", secondHour: SH(["Tue"]), maxTrades: 2, lockPct: 0.5, days: ["Tue"], window: "11:16–12:10 (trade 2 until 13:10)", exit: TRAIL, backtest: { trades: 106, wins: 106, losses: 0, source: "PROJECT_NEXUS/MATHI_SECOND_HOUR_TUESDAY" } },
  { key: "M1315_V2", name: "Mathi 13:15 Minute v2", family: "m1315", m1315: { version: 2 }, maxTrades: 2, lockPct: 0.7, days: WEEK, window: "13:16–13:25 (trade 2 until 13:45)", exit: TRAIL, backtest: { trades: 238, wins: 238, losses: 0, source: "PROJECT_NEXUS/MATHI_1315_MINUTE/FIXED_v2_2026-11-19" } },
  { key: "SH_ALL", name: "Mathi Second Hour (All Days)", family: "second_hour", secondHour: SH(null), maxTrades: 2, lockPct: 0.5, days: WEEK, window: "11:16–12:10 (trade 2 until 13:10)", exit: TRAIL, backtest: { trades: 537, wins: 532, losses: 5, source: "PROJECT_NEXUS/MATHI_SECOND_HOUR" } },
  { key: "MHB_FINAL", name: "Mathi Hourly Breakout FINAL", family: "second_hour", secondHour: { onlyDays: null, oneTrade: true, allowGapDown: false, wedMomentum: false }, maxTrades: 1, lockPct: null, days: ["Mon", "Tue", "Thu", "Fri"], window: "11:16–12:10, 1 trade", exit: TRAIL, backtest: { trades: 320, wins: 318, losses: 2, source: "mathi_second_hour.py --one-trade --no-gapdown --no-wedmom" } },
  { key: "MONWED", name: "MonWed", family: "monwed", maxTrades: 1, lockPct: null, days: ["Mon", "Wed"], window: "10:15", exit: "+1.48% limit target from 10:15; else 15:20", backtest: { trades: 245, wins: 230, losses: 15, source: "NIFTY_HOURLY_ATM_CE_2PT/monwed.py (fixed exit)" } },
];

export const AUTO_KEYS = AUTO_STRATEGIES.map((item) => item.key);
export const autoStrategy = (key: string) => AUTO_STRATEGIES.find((item) => item.key === key) ?? null;
export const DAY_CAPITAL_PAISE = 20_000_00;

/** MonWed's event calendar (monwed.py lists + published 2026–27 RBI / FOMC dates, 24 Nov 2026). Editable in AppSetting. */
export const MONWED_EVENTS_DEFAULT = {
  rbi: ["2021-12-08", "2022-02-10", "2022-04-08", "2022-05-04", "2022-06-08", "2022-08-05", "2022-09-30", "2022-12-07", "2023-02-08", "2023-04-06", "2023-06-08", "2023-08-10", "2023-10-06", "2023-12-08", "2024-02-08", "2024-04-05", "2024-06-07", "2024-08-08", "2024-10-09", "2024-12-06", "2025-02-07", "2025-04-09", "2025-06-06", "2025-08-06", "2025-10-01", "2025-12-05", "2026-02-06",
    "2026-04-08", "2026-06-05", "2026-08-05", "2026-10-07", "2026-12-04", "2027-02-05"],
  fomc: ["2021-11-03", "2021-12-15", "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14", "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13", "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18", "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10", "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28",
    "2026-12-09", "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-11-17"],
  election: ["2024-04-19", "2024-04-26", "2024-05-07", "2024-05-13", "2024-05-20", "2024-06-04", "2022-03-10", "2022-12-08", "2023-12-04", "2024-10-08", "2025-11-14"],
  budget: ["2022-02-01", "2023-02-01", "2024-02-01", "2024-07-23", "2025-02-01", "2026-02-01", "2027-02-01"],
  tariff: ["2025-04-03", "2025-04-07", "2025-07-09", "2025-08-01", "2025-08-07", "2025-08-27"],
};
export type MonWedEvents = typeof MONWED_EVENTS_DEFAULT;
export const MONWED_EVENTS_KEY = "auto.monwed.events";
