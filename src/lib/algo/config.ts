import { ALL_LINE_TYPES, type CustomLevel, type LineType } from "./lines";
import { protectiveProblem, type Protective } from "./options";
import { ALGO_DEFAULTS, type AlgoConfig, type AlgoState } from "./runner";
import { PATTERN_DEFAULTS, STRATEGY_IDS, type PatternSettings } from "./patterns";

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
  return {
    ...ALGO_DEFAULTS,
    underlying: typeof row.underlying === "string" && /^[A-Z0-9&_-]{1,20}$/.test(row.underlying.trim().toUpperCase()) ? row.underlying.trim().toUpperCase() : ALGO_DEFAULTS.underlying,
    mode: row.mode === "REPLAY" || row.mode === "LIVE" || row.mode === "PAPER" ? row.mode : ALGO_DEFAULTS.mode,
    expiry: typeof row.expiry === "string" && (row.expiry === "nearest" || /^\d{4}-\d{2}-\d{2}$/.test(row.expiry)) ? row.expiry : "nearest",
    lots: Number.isFinite(num(row.lots)) ? num(row.lots) : ALGO_DEFAULTS.lots,
    // Settings from before version 3 with a premium stop under 20% / target under 40% (too tight for 1-minute
    // ATM options) move to 20% / 40% once, with the structure stop; later choices are kept.
    stop: upgrade(protective(row.stop, ALGO_DEFAULTS.stop), row, 20),
    target: upgrade(protective(row.target, ALGO_DEFAULTS.target), row, 40),
    maxDailyLoss: Number.isFinite(num(row.maxDailyLoss)) ? num(row.maxDailyLoss) : ALGO_DEFAULTS.maxDailyLoss,
    maxTrades: Number.isFinite(num(row.maxTrades)) ? num(row.maxTrades) : ALGO_DEFAULTS.maxTrades,
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
    entryCutoff: typeof row.entryCutoff === "string" && /^(09|1[0-5]):[0-5]\d$/.test(row.entryCutoff) ? row.entryCutoff : ALGO_DEFAULTS.entryCutoff,
    strategies: strategiesOf(row.strategies),
    // Settings saved before version 2 with the old 15-minute default move to 30 once; a later choice is kept.
    observationMinutes: !Number.isFinite(num(row.observationMinutes)) || (!(num(row.settingsVersion) >= 2) && num(row.observationMinutes) === 15) ? ALGO_DEFAULTS.observationMinutes : num(row.observationMinutes),
    settingsVersion: ALGO_DEFAULTS.settingsVersion,
    filters: filtersOf(row.filters),
    structureStop: typeof row.structureStop === "boolean" ? row.structureStop : ALGO_DEFAULTS.structureStop,
    patterns: patternsOf(row.patterns),
  };
}

function upgrade(value: Protective, row: Raw, floor: number): Protective {
  if (num(row.settingsVersion) >= 3 || value.mode !== "percent" || value.value >= floor) return value;
  return { mode: "percent", value: floor };
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
  };
}

/** Every problem with the settings (empty when valid). */
export function algoConfigProblems(config: AlgoConfig): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(config.lots) || config.lots < 1 || config.lots > 50) problems.push("Quantity must be 1 to 50 lots.");
  const protect = protectiveProblem(config.stop, config.target);
  if (protect) problems.push(protect);
  if (config.stop.mode === "percent" && config.stop.value > 90) problems.push("A stop-loss above 90% of the premium is not allowed.");
  if (!(config.maxDailyLoss > 0)) problems.push("The maximum daily loss must be more than ₹0.");
  if (!Number.isInteger(config.maxTrades) || config.maxTrades < 1 || config.maxTrades > 50) problems.push("The trades-per-session limit must be 1 to 50.");
  if (!Number.isInteger(config.cooldownMinutes) || config.cooldownMinutes < 0 || config.cooldownMinutes > 120) problems.push("The cooldown must be 0 to 120 minutes.");
  if (!(config.maxSpreadPercent > 0 && config.maxSpreadPercent <= 50)) problems.push("The maximum spread must be above 0% and at most 50%.");
  if (!(config.maxQuoteAgeSeconds >= 5 && config.maxQuoteAgeSeconds <= 600)) problems.push("The quote freshness limit must be 5 to 600 seconds.");
  if (!Number.isInteger(config.slippageTicks) || config.slippageTicks < 0 || config.slippageTicks > 20) problems.push("Slippage must be 0 to 20 ticks.");
  for (const level of config.custom) if (!(level.price > 0)) problems.push(`The extra level "${level.label || level.id}" needs a price above 0.`);
  if (!STRATEGY_IDS.some((id) => config.strategies[id])) problems.push("Switch on at least one strategy.");
  if (!Number.isInteger(config.observationMinutes) || config.observationMinutes < 0 || config.observationMinutes > 120) problems.push("The observation period must be 0 to 120 minutes.");
  const pattern = config.patterns;
  if (!Number.isInteger(pattern.pivotStrength) || pattern.pivotStrength < 1 || pattern.pivotStrength > 5) problems.push("Swing sensitivity must be 1 to 5 candles.");
  if (!Number.isInteger(pattern.minSeparation) || pattern.minSeparation < 2 || pattern.minSeparation > 60) problems.push("The minimum separation between bottoms / tops must be 2 to 60 candles.");
  if (!(pattern.tolerancePercent > 0 && pattern.tolerancePercent <= 2)) problems.push("The double-bottom / top tolerance must be above 0% and at most 2%.");
  if (!(pattern.minBreakPercent >= 0 && pattern.minBreakPercent <= 1)) problems.push("The minimum breakout distance must be 0% to 1%.");
  if (!Number.isInteger(pattern.retestBars) || pattern.retestBars < 1 || pattern.retestBars > 60) problems.push("The retest window must be 1 to 60 candles.");
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
