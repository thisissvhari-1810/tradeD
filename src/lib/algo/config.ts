import { ALL_LINE_TYPES, type CustomLevel, type LineType } from "./lines";
import { protectiveProblem, type Protective } from "./options";
import { ALGO_DEFAULTS, type AlgoConfig, type AlgoState } from "./runner";
import { PATTERN_DEFAULTS, STRATEGY_IDS, type PatternSettings } from "./patterns";
import { ALLOCATION_DEFAULTS, RISK_DEFAULTS, type AllocationSettings, type RiskSettings } from "./sizing";
import { PRIMARY_SETTINGS_DEFAULTS, type PrimarySettings } from "./primary";

/**
 * Reads and validates Algo settings (the server applies this to every save, so limits are never only a
 * UI matter). Invalid values are reported, never silently loosened: a quantity, stop or limit that does
 * not validate is an error, not a clamp.
 */

type Raw = Record<string, unknown>;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : NaN);

function protective(value: unknown, fallback: Protective): Protective {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  return { mode: row.mode === "points" ? "points" : row.mode === "percent" ? "percent" : fallback.mode, value: Number.isFinite(num(row.value)) ? num(row.value) : fallback.value };
}

/** Merges saved or submitted settings over the defaults (unknown fields are dropped). */
export function readAlgoConfig(raw: unknown): AlgoConfig {
  const row = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const lineTypes = new Set<LineType>(ALL_LINE_TYPES);
  const custom = Array.isArray(row.custom) ? row.custom : [];
  // Settings saved before version 4 move once to the early-session strategy: entries 09:15–10:30 with no
  // observation wait, risk-based sizing (₹500 a trade, ₹1,500 a day on ₹1,00,000) and up to 10 lots.
  const time = (value: unknown, fallback: string) => (typeof value === "string" && /^(09|1[0-5]):[0-5]\d$/.test(value) ? value : fallback);
  const early = num(row.settingsVersion) >= 4;
  // Version 5 widens the entry window to 12:00: a saved 10:30 (the version 4 default) moves once.
  const savedCutoff = time(row.entryCutoff, ALGO_DEFAULTS.entryCutoff);
  const cutoff = num(row.settingsVersion) >= 5 || savedCutoff !== "10:30" ? savedCutoff : ALGO_DEFAULTS.entryCutoff;
  // Version 6: the stop beyond the broken line, 1% (₹1,000) risk a trade, ₹2,000 a day and a ₹3,000 (3%) target.
  // Only values still at the version 4 / 5 defaults move; anything chosen since is kept.
  const v6 = num(row.settingsVersion) >= 6;
  const kept = (value: number, old: number, next: number) => (!v6 && value === old ? next : value);
  // Version 7 makes Mathi Strategy a line-breakout strategy: enabled strategy lines only, 50% of the body across
  // the line, a fixed lot count, +3% on the premium, no stop-loss, three entries a session. Applied once to
  // saved Mathi settings (never to Algo - Primary Strategy's).
  const mathi = row.engine !== "primary";
  const v7 = num(row.settingsVersion) >= 7 || !mathi;
  // Version 8: Mathi Strategy has no entry cutoff (entries until the session's close); a saved cutoff moves once.
  const v8 = num(row.settingsVersion) >= 8 || !mathi;
  // Version 10: Mathi Strategy enters once 50% of the body is past the line; a saved share moves to 50% once.
  const v10 = num(row.settingsVersion) >= 10 || !mathi;
  // Version 11: Mathi Strategy confirms a breakout before entering (the next candle must hold beyond the line);
  // saved Mathi settings move to that once. Algo - Primary Strategy keeps its own engine's confirmation.
  const v11 = num(row.settingsVersion) >= 11;
  // Version 12: Mathi Strategy exits when the index closes back through the broken line and needs the 9 / 21 EMA
  // trend to agree (the month's backtest: the one unprotected loss was a counter-trend breakout that failed);
  // saved Mathi settings move to both once.
  const v12 = num(row.settingsVersion) >= 12 || !mathi;
  return {
    ...ALGO_DEFAULTS,
    underlying: typeof row.underlying === "string" && /^[A-Z0-9&_-]{1,20}$/.test(row.underlying.trim().toUpperCase()) ? row.underlying.trim().toUpperCase() : ALGO_DEFAULTS.underlying,
    mode: row.mode === "REPLAY" || row.mode === "LIVE" || row.mode === "PAPER" ? row.mode : ALGO_DEFAULTS.mode,
    expiry: typeof row.expiry === "string" && (row.expiry === "nearest" || /^\d{4}-\d{2}-\d{2}$/.test(row.expiry)) ? row.expiry : "nearest",
    lots: early && v7 && Number.isFinite(num(row.lots)) ? num(row.lots) : ALGO_DEFAULTS.lots,
    // Settings from before version 3 with a premium stop under 20% / target under 40% (too tight for 1-minute
    // ATM options) move to 20% / 40% once, with the structure stop; later choices are kept.
    stop: v7 ? upgrade(protective(row.stop, ALGO_DEFAULTS.stop), row, 20) : ALGO_DEFAULTS.stop,
    target: v7 ? upgrade(protective(row.target, ALGO_DEFAULTS.target), row, 40) : ALGO_DEFAULTS.target,
    maxDailyLoss: early && Number.isFinite(num(row.maxDailyLoss)) ? kept(num(row.maxDailyLoss), 1_500, ALGO_DEFAULTS.maxDailyLoss) : ALGO_DEFAULTS.maxDailyLoss,
    maxTrades: v7 && Number.isFinite(num(row.maxTrades)) ? num(row.maxTrades) : ALGO_DEFAULTS.maxTrades,
    cooldownMinutes: Number.isFinite(num(row.cooldownMinutes)) ? num(row.cooldownMinutes) : ALGO_DEFAULTS.cooldownMinutes,
    disabledLines: Array.isArray(row.disabledLines) ? row.disabledLines.filter((type): type is LineType => typeof type === "string" && (lineTypes.has(type as LineType) || type === "custom")) : [],
    custom: custom
      .filter((item): item is Raw => Boolean(item) && typeof item === "object")
      .slice(0, 12)
      .map((item, index) => ({ id: typeof item.id === "string" && /^[a-z0-9-]{1,24}$/.test(item.id) ? item.id : `level-${index + 1}`, label: typeof item.label === "string" ? item.label.slice(0, 40) : "", price: num(item.price) }))
      .filter((item: CustomLevel) => Number.isFinite(item.price)),
    opposingPolicy: row.opposingPolicy === "exit-first" ? "exit-first" : "ignore",
    rounding: row.rounding === "down" || row.rounding === "up" ? row.rounding : "nearest",
    maxQuoteAgeSeconds: Number.isFinite(num(row.maxQuoteAgeSeconds)) ? num(row.maxQuoteAgeSeconds) : ALGO_DEFAULTS.maxQuoteAgeSeconds,
    maxSpreadPercent: Number.isFinite(num(row.maxSpreadPercent)) ? num(row.maxSpreadPercent) : ALGO_DEFAULTS.maxSpreadPercent,
    slippageTicks: Number.isFinite(num(row.slippageTicks)) ? num(row.slippageTicks) : ALGO_DEFAULTS.slippageTicks,
    entryStart: time(row.entryStart, ALGO_DEFAULTS.entryStart),
    entryCutoff: !v8 ? ALGO_DEFAULTS.entryCutoff : early ? cutoff : mathi ? ALGO_DEFAULTS.entryCutoff : "12:00",
    windowExit: row.windowExit === "close" ? "close" : "hold",
    sizing: !v7 ? "capital" : !early ? "risk" : row.sizing === "fixed" ? "fixed" : row.sizing === "capital" ? "capital" : "risk",
    allocation: allocationOf(row.allocation),
    risk: ((risk) => ({ ...risk, perTradePercent: kept(risk.perTradePercent, 0.5, RISK_DEFAULTS.perTradePercent), dailyTarget: kept(risk.dailyTarget, 5_000, RISK_DEFAULTS.dailyTarget) }))(riskOf(row.risk)),
    minScore: Number.isFinite(num(row.minScore)) ? num(row.minScore) : ALGO_DEFAULTS.minScore,
    // Mathi Strategy trades strategy-line crossings only; the other setups cannot be switched on for it.
    strategies: mathi ? { ...ALGO_DEFAULTS.strategies } : strategiesOf(row.strategies),
    engine: row.engine === "primary" ? "primary" : "existing",
    primary: primaryOf(row.primary),
    // Settings saved before version 2 with the old 15-minute default move to 30 once; a later choice is kept.
    observationMinutes: !early || !Number.isFinite(num(row.observationMinutes)) ? ALGO_DEFAULTS.observationMinutes : num(row.observationMinutes),
    settingsVersion: ALGO_DEFAULTS.settingsVersion,
    filters: ((filters) => (v12 ? filters : { ...filters, momentum: true }))(v7 ? filtersOf(row.filters) : { ...ALGO_DEFAULTS.filters }),
    structureStop: !v12 ? true : v7 && typeof row.structureStop === "boolean" ? row.structureStop : ALGO_DEFAULTS.structureStop,
    crossRule: row.crossRule === "classic" || (!mathi && row.crossRule !== "body") ? "classic" : "body",
    crossPercent: v10 && Number.isFinite(num(row.crossPercent)) ? num(row.crossPercent) : mathi ? ALGO_DEFAULTS.crossPercent : 0,
    stopLoss: v7 && typeof row.stopLoss === "boolean" ? row.stopLoss : !mathi,
    intrabar: v7 && typeof row.intrabar === "boolean" ? row.intrabar : mathi,
    stopAtLimit: v7 && typeof row.stopAtLimit === "boolean" ? row.stopAtLimit : !mathi,
    confirmation: !mathi ? { ...ALGO_DEFAULTS.confirmation, mode: "single" } : v11 ? confirmationOf(row.confirmation) : { ...ALGO_DEFAULTS.confirmation },
    patterns: ((patterns) => (v6 ? patterns : { ...patterns, trendStop: PATTERN_DEFAULTS.trendStop }))(patternsOf(row.patterns)),
  };
}

function upgrade(value: Protective, row: Raw, floor: number): Protective {
  if (num(row.settingsVersion) >= 3 || value.mode !== "percent" || value.value >= floor) return value;
  return { mode: "percent", value: floor };
}

function allocationOf(value: unknown): AllocationSettings {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  return {
    percent: Number.isFinite(num(row.percent)) ? num(row.percent) : ALLOCATION_DEFAULTS.percent,
    maxCapital: Number.isFinite(num(row.maxCapital)) ? num(row.maxCapital) : ALLOCATION_DEFAULTS.maxCapital,
    policy: row.policy === "reject" ? "reject" : "reduce",
  };
}

function riskOf(value: unknown): RiskSettings {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  const pick = (key: Exclude<keyof RiskSettings, "stopAtTarget" | "targetMode">) => (Number.isFinite(num(row[key])) ? num(row[key]) : RISK_DEFAULTS[key]);
  return {
    capital: pick("capital"),
    perTradePercent: pick("perTradePercent"),
    dailyTarget: pick("dailyTarget"),
    stopAtTarget: typeof row.stopAtTarget === "boolean" ? row.stopAtTarget : RISK_DEFAULTS.stopAtTarget,
    minRewardRisk: pick("minRewardRisk"),
    minStopPercent: pick("minStopPercent"),
    targetMode: row.targetMode === "level" || row.targetMode === "trail" ? row.targetMode : "multiple",
  };
}

function filtersOf(value: unknown): AlgoConfig["filters"] {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  const fallback = ALGO_DEFAULTS.filters;
  return {
    levelBlockMinutes: Number.isFinite(num(row.levelBlockMinutes)) ? num(row.levelBlockMinutes) : fallback.levelBlockMinutes,
    breakoutBufferPercent: Number.isFinite(num(row.breakoutBufferPercent)) ? num(row.breakoutBufferPercent) : fallback.breakoutBufferPercent,
    secondCandle: typeof row.secondCandle === "boolean" ? row.secondCandle : fallback.secondCandle,
    momentum: typeof row.momentum === "boolean" ? row.momentum : fallback.momentum,
  };
}

function confirmationOf(value: unknown): AlgoConfig["confirmation"] {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  const fallback = ALGO_DEFAULTS.confirmation;
  return {
    mode: row.mode === "single" || row.mode === "hold" || row.mode === "retest" ? row.mode : fallback.mode,
    retestTolerancePercent: Number.isFinite(num(row.retestTolerancePercent)) ? num(row.retestTolerancePercent) : fallback.retestTolerancePercent,
    retestWindowMinutes: Number.isFinite(num(row.retestWindowMinutes)) ? num(row.retestWindowMinutes) : fallback.retestWindowMinutes,
    holdMustAgree: typeof row.holdMustAgree === "boolean" ? row.holdMustAgree : fallback.holdMustAgree,
  };
}

function primaryOf(value: unknown): PrimarySettings {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  const d = PRIMARY_SETTINGS_DEFAULTS;
  const pick = (key: "orMinutes" | "trendFast" | "trendSlow" | "retestBars" | "breakBufferPercent" | "confirmBars") => (Number.isFinite(num(row[key])) ? num(row[key]) : d[key]);
  return {
    orMinutes: pick("orMinutes"),
    vwap: typeof row.vwap === "boolean" ? row.vwap : d.vwap,
    vwapFallback: row.vwapFallback === "reject" ? "reject" : "twap",
    trend: row.trend === "none" ? "none" : "ema",
    trendFast: pick("trendFast"),
    trendSlow: pick("trendSlow"),
    retest: typeof row.retest === "boolean" ? row.retest : d.retest,
    retestBars: pick("retestBars"),
    breakBufferPercent: pick("breakBufferPercent"),
    stopBasis: row.stopBasis === "mid" || row.stopBasis === "range" ? row.stopBasis : "candle",
    confirmBars: pick("confirmBars"),
    continuation: typeof row.continuation === "boolean" ? row.continuation : d.continuation,
    supportBreak: typeof row.supportBreak === "boolean" ? row.supportBreak : d.supportBreak,
  };
}

function strategiesOf(value: unknown): AlgoConfig["strategies"] {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  return Object.fromEntries(STRATEGY_IDS.map((id) => [id, typeof row[id] === "boolean" ? row[id] : ALGO_DEFAULTS.strategies[id]])) as AlgoConfig["strategies"];
}

function patternsOf(value: unknown): PatternSettings {
  const row = (value && typeof value === "object" ? value : {}) as Raw;
  const pick = (key: keyof PatternSettings) => (Number.isFinite(num(row[key])) ? num(row[key]) : (PATTERN_DEFAULTS[key] as number));
  return {
    pivotStrength: pick("pivotStrength"),
    minSeparation: pick("minSeparation"),
    tolerancePercent: pick("tolerancePercent"),
    minBreakPercent: pick("minBreakPercent"),
    retest: typeof row.retest === "boolean" ? row.retest : PATTERN_DEFAULTS.retest,
    retestBars: pick("retestBars"),
    volume: typeof row.volume === "boolean" ? row.volume : PATTERN_DEFAULTS.volume,
    orbMinutes: pick("orbMinutes"),
    zoneTolerancePercent: pick("zoneTolerancePercent"),
    breakMode: row.breakMode === "intrabar" ? "intrabar" : "close",
    bufferMode: row.bufferMode === "points" || row.bufferMode === "atr" ? row.bufferMode : "percent",
    bufferValue: pick("bufferValue"),
    trendStop: row.trendStop === "line" ? "line" : "swing",
  };
}

/** Every problem with the settings (empty when valid). */
export function algoConfigProblems(config: AlgoConfig): string[] {
  const problems: string[] = [];
  const risky = config.sizing === "risk";
  if (!Number.isInteger(config.crossPercent) || config.crossPercent < 0 || config.crossPercent > 100) problems.push("The share of the body past the line must be 0 (any crossing) to 100%.");
  const confirmation = config.confirmation ?? ALGO_DEFAULTS.confirmation;
  if (confirmation.mode === "retest") {
    if (!(confirmation.retestTolerancePercent >= 0 && confirmation.retestTolerancePercent <= 0.5)) problems.push("The retest tolerance must be 0% to 0.5% of the line.");
    if (!Number.isInteger(confirmation.retestWindowMinutes) || confirmation.retestWindowMinutes < 2 || confirmation.retestWindowMinutes > 120) problems.push("The retest window must be 2 to 120 minutes.");
  }
  if (config.sizing === "capital") {
    if (!(config.allocation.percent > 0 && config.allocation.percent <= 100)) problems.push("Capital allocation must be above 0% and at most 100%.");
    if (!(config.allocation.maxCapital >= 1_000 && config.allocation.maxCapital <= 100_000_000)) problems.push("Maximum capital must be ₹1,000 to ₹10,00,00,000.");
  }
  if (!Number.isInteger(config.lots) || config.lots < 1 || config.lots > 50) problems.push(risky ? "Maximum lots must be 1 to 50." : "Quantity must be 1 to 50 lots.");
  if (!risky && config.stopLoss === false && !(config.target.value > 0)) problems.push("The profit target must be above 0.");
  if (!risky && config.stopLoss !== false) {
    const protect = protectiveProblem(config.stop, config.target);
    if (protect) problems.push(protect);
    if (config.stop.mode === "percent" && config.stop.value > 90) problems.push("A stop-loss above 90% of the premium is not allowed.");
  }
  const risk = config.risk;
  if (!(risk.capital >= 10_000 && risk.capital <= 100_000_000)) problems.push("Capital must be ₹10,000 to ₹10,00,00,000.");
  if (!(risk.perTradePercent > 0 && risk.perTradePercent <= 5)) problems.push("Risk per trade must be above 0% and at most 5% of capital.");
  if (!(risk.dailyTarget > 0)) problems.push("The daily target must be more than ₹0.");
  if (!(risk.minRewardRisk >= 0.5 && risk.minRewardRisk <= 10)) problems.push("The minimum reward : risk must be 0.5 to 10.");
  if (!(risk.minStopPercent >= 0.01 && risk.minStopPercent <= 2)) problems.push("The minimum stop distance must be 0.01% to 2%.");
  if (!Number.isInteger(config.minScore) || config.minScore < 0 || config.minScore > 100) problems.push("The minimum setup score must be 0 to 100.");
  if (config.entryStart >= config.entryCutoff) problems.push("The entry window must start before it ends.");
  if (risky && config.maxDailyLoss > risk.capital) problems.push("The maximum daily loss cannot be more than the capital.");
  if (!(config.maxDailyLoss > 0)) problems.push("The maximum daily loss must be more than ₹0.");
  if (!Number.isInteger(config.maxTrades) || config.maxTrades < 1 || config.maxTrades > 50) problems.push("The trades-per-session limit must be 1 to 50.");
  if (!Number.isInteger(config.cooldownMinutes) || config.cooldownMinutes < 0 || config.cooldownMinutes > 120) problems.push("The cooldown must be 0 to 120 minutes.");
  if (!(config.maxSpreadPercent > 0 && config.maxSpreadPercent <= 50)) problems.push("The maximum spread must be above 0% and at most 50%.");
  if (!(config.maxQuoteAgeSeconds >= 5 && config.maxQuoteAgeSeconds <= 600)) problems.push("The quote freshness limit must be 5 to 600 seconds.");
  if (!Number.isInteger(config.slippageTicks) || config.slippageTicks < 0 || config.slippageTicks > 20) problems.push("Slippage must be 0 to 20 ticks.");
  for (const level of config.custom) if (!(level.price > 0)) problems.push(`The extra level "${level.label || level.id}" needs a price above 0.`);
  if (config.engine !== "primary" && !STRATEGY_IDS.some((id) => config.strategies[id])) problems.push("Switch on at least one strategy.");
  if (config.engine === "primary") {
    const primary = config.primary;
    if (config.mode !== "REPLAY") problems.push("Algo - Primary Strategy runs in chart replay (demo trading) only.");
    if (!Number.isInteger(primary.orMinutes) || primary.orMinutes < 5 || primary.orMinutes > 60) problems.push("The opening range must be 5 to 60 minutes.");
    if (!Number.isInteger(primary.trendFast) || !Number.isInteger(primary.trendSlow) || primary.trendFast < 2 || primary.trendSlow <= primary.trendFast || primary.trendSlow > 100) problems.push("The trend EMAs must be whole numbers with the fast one shorter than the slow one (at most 100).");
    if (!Number.isInteger(primary.retestBars) || primary.retestBars < 1 || primary.retestBars > 60) problems.push("The retest window must be 1 to 60 candles.");
    if (!(primary.breakBufferPercent >= 0 && primary.breakBufferPercent <= 1)) problems.push("The breakout buffer must be 0% to 1%.");
    if (!Number.isInteger(primary.confirmBars) || primary.confirmBars < 0 || primary.confirmBars > 60) problems.push("The confirmation window must be 0 to 60 candles.");
  }
  if (!Number.isInteger(config.observationMinutes) || config.observationMinutes < 0 || config.observationMinutes > 120) problems.push("The observation period must be 0 to 120 minutes.");
  const pattern = config.patterns;
  if (!Number.isInteger(pattern.pivotStrength) || pattern.pivotStrength < 1 || pattern.pivotStrength > 5) problems.push("Swing sensitivity must be 1 to 5 candles.");
  if (!Number.isInteger(pattern.minSeparation) || pattern.minSeparation < 2 || pattern.minSeparation > 60) problems.push("The minimum separation between bottoms / tops must be 2 to 60 candles.");
  if (!(pattern.tolerancePercent > 0 && pattern.tolerancePercent <= 2)) problems.push("The double-bottom / top tolerance must be above 0% and at most 2%.");
  if (!(pattern.minBreakPercent >= 0 && pattern.minBreakPercent <= 1)) problems.push("The minimum breakout distance must be 0% to 1%.");
  if (!Number.isInteger(pattern.retestBars) || pattern.retestBars < 1 || pattern.retestBars > 60) problems.push("The retest window must be 1 to 60 candles.");
  if (!Number.isInteger(pattern.orbMinutes) || pattern.orbMinutes < 1 || pattern.orbMinutes > 60) problems.push("The opening range must be 1 to 60 minutes.");
  if (!(pattern.zoneTolerancePercent >= 0 && pattern.zoneTolerancePercent <= 1)) problems.push("The support / resistance zone tolerance must be 0% to 1%.");
  const bufferLimit = pattern.bufferMode === "points" ? 200 : pattern.bufferMode === "atr" ? 5 : 1;
  if (!(pattern.bufferValue >= 0 && pattern.bufferValue <= bufferLimit)) problems.push(`The trendline breakout buffer must be 0 to ${bufferLimit}${pattern.bufferMode === "points" ? " points" : pattern.bufferMode === "atr" ? "× the average range" : "%"}.`);
  if (pattern.breakMode === "intrabar" && config.mode === "LIVE") problems.push("Intrabar breakout detection is for paper trading and replay only; live trading needs candle-close confirmation.");
  if (!Number.isInteger(config.filters.levelBlockMinutes) || config.filters.levelBlockMinutes < 0 || config.filters.levelBlockMinutes > 240) problems.push("The level block after a stop must be 0 to 240 minutes.");
  if (!(config.filters.breakoutBufferPercent >= 0 && config.filters.breakoutBufferPercent <= 1)) problems.push("The breakout buffer must be 0% to 1%.");
  return problems;
}

/**
 * Switching the Algo to chart replay (historical paper trading on the replay clock), from the chart's
 * Enable switch. A live-price paper position or pending order must be closed first (it is never moved
 * between clocks); a running live-price session is stopped, so the two modes never run at once.
 */
export function switchToChartReplay(config: AlgoConfig, state: Pick<AlgoState, "running" | "entries" | "position" | "pending">): { ok: true; config: AlgoConfig; stopped: boolean } | { ok: false; reason: string } {
  if (config.mode === "REPLAY") return { ok: true, config, stopped: false };
  if (state.position || state.pending) return { ok: false, reason: "A live-price paper position or order is open. Exit it in Strategy → Algo trade before switching the Algo to chart replay." };
  return { ok: true, config: { ...config, mode: "REPLAY" }, stopped: state.running };
}
