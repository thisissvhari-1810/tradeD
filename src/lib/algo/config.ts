import { ALL_LINE_TYPES, type CustomLevel, type LineType } from "./lines";
import { protectiveProblem, type Protective } from "./options";
import { ALGO_DEFAULTS, type AlgoConfig, type AlgoState } from "./runner";

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
    stop: protective(row.stop, ALGO_DEFAULTS.stop),
    target: protective(row.target, ALGO_DEFAULTS.target),
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
