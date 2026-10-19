import { parseColor } from "@/lib/color/palette";

export type AppTokens = {
  background: string;
  panel: string;
  elevated: string;
  primary: string;
  onPrimary: string;
  profit: string;
  loss: string;
  warning: string;
  info: string;
  demo: string;
  text: string;
  muted: string;
  border: string;
  grid: string;
};

export type ChartPaint = {
  background: string;
  text: string;
  grid: string;
  crosshair: string;
  border: string;
  bullBody: string;
  bearBody: string;
  bullWick: string;
  bearWick: string;
  bullBorder: string;
  bearBorder: string;
  volumeUp: string;
  volumeDown: string;
  priceLine: string;
  smaFast: string;
  smaSlow: string;
  ema: string;
  vwap: string;
  bands: string;
  rsi: string;
  macd: string;
  macdSignal: string;
  indicatorWidth: number;
  indicatorOpacity: number;
  indicatorStyle: "solid" | "dashed" | "dotted";
};

export type SavedTheme = {
  id: string;
  name: string;
  mode: "dark" | "light";
  tokens: AppTokens;
  chart: ChartPaint;
};

export type Appearance = {
  presetId: string;
  mode: "dark" | "light";
  tokens: AppTokens;
  chart: ChartPaint;
  recent: string[];
  favorites: string[];
  custom: SavedTheme[];
};

/* Keep in sync with src/app/tokens.css. */
const LIGHT_TOKENS: AppTokens = {
  background: "#F3F6FA", panel: "#FFFFFF", elevated: "#FFFFFF", primary: "#315FDE", onPrimary: "#FFFFFF",
  profit: "#087F5B", loss: "#C73750", warning: "#9A6500", info: "#1769AA", demo: "#7047C8",
  text: "#172033", muted: "#66758A", border: "#E0E6EF", grid: "#EEF1F6",
};

const DARK_TOKENS: AppTokens = {
  background: "#090C12", panel: "#101620", elevated: "#18212D", primary: "#648CFF", onPrimary: "#0A1020",
  profit: "#35D39A", loss: "#FF7185", warning: "#F4BE5E", info: "#67B7FF", demo: "#B89AFF",
  text: "#F1F5FB", muted: "#8492A6", border: "#283444", grid: "#18202B",
};

/* Keep in sync with the --chart-* variables in src/app/tokens.css. */
const CHART_TOKENS = {
  light: { background: "#FFFFFF", grid: "#EEF1F6", crosshair: "#8593A8", text: "#46546A", up: "#089981", down: "#F23645", priceLine: "#315FDE" },
  dark: { background: "#101620", grid: "#161E29", crosshair: "#5D6B80", text: "#B4C0D0", up: "#089981", down: "#F23645", priceLine: "#648CFF" },
} as const;

const LEGACY_PRESETS = new Set(["midnight", "emerald", "purple", "mono", "ocean", "sunset", "contrast"]);

function chartFrom(tokens: AppTokens, mode: "dark" | "light"): ChartPaint {
  const paint = CHART_TOKENS[mode];
  return {
    background: paint.background, text: paint.text, grid: paint.grid, crosshair: paint.crosshair, border: tokens.border,
    bullBody: paint.up, bearBody: paint.down, bullWick: paint.up, bearWick: paint.down, bullBorder: paint.up, bearBorder: paint.down,
    volumeUp: paint.up, volumeDown: paint.down, priceLine: paint.priceLine,
    smaFast: tokens.primary, smaSlow: mode === "light" ? "#B7791F" : "#E8B34A", ema: mode === "light" ? "#7047C8" : "#B89AFF", vwap: tokens.info, bands: mode === "light" ? "#8593A8" : "#6B7A90",
    rsi: mode === "light" ? "#7047C8" : "#B89AFF", macd: tokens.primary, macdSignal: mode === "light" ? "#B7791F" : "#E8B34A", indicatorWidth: 1, indicatorOpacity: 1, indicatorStyle: "solid",
  };
}

function theme(id: string, name: string, mode: "dark" | "light", tokens: AppTokens, chart?: Partial<ChartPaint>): SavedTheme {
  return { id, name, mode, tokens, chart: { ...chartFrom(tokens, mode), ...chart } };
}

export const THEME_PRESETS: SavedTheme[] = [
  theme("classic", "Dark", "dark", DARK_TOKENS),
  theme("light", "Light", "light", LIGHT_TOKENS),
];

export function emptyAppearance(presetId = "light"): Appearance {
  const preset = THEME_PRESETS.find((item) => item.id === presetId) ?? THEME_PRESETS[1];
  return { presetId: preset.id, mode: preset.mode, tokens: { ...preset.tokens }, chart: { ...preset.chart }, recent: [], favorites: [], custom: [] };
}

export function appearanceKey(userId = "") {
  return `td-appearance:${userId || "local"}`;
}

export function normalizeAppearance(value: unknown): Appearance {
  const fallback = emptyAppearance();
  if (!value || typeof value !== "object") return fallback;
  const row = value as Partial<Appearance>;
  const presetId = typeof row.presetId === "string" && LEGACY_PRESETS.has(row.presetId) ? "classic" : row.presetId;
  const preset = THEME_PRESETS.find((item) => item.id === presetId);
  const tokens = preset ? { ...preset.tokens } : { ...fallback.tokens, ...(row.tokens ?? {}) };
  const chart = preset ? { ...preset.chart, ...pickIndicatorPrefs(row.chart) } : { ...fallback.chart, ...(row.chart ?? {}) };
  chart.indicatorWidth = Math.min(4, Math.max(1, Number(chart.indicatorWidth) || 1));
  chart.indicatorOpacity = Math.min(1, Math.max(0.1, Number(chart.indicatorOpacity) || 1));
  chart.indicatorStyle = chart.indicatorStyle === "dashed" || chart.indicatorStyle === "dotted" ? chart.indicatorStyle : "solid";
  return {
    presetId: preset?.id ?? (typeof presetId === "string" ? presetId : fallback.presetId),
    mode: preset ? preset.mode : row.mode === "dark" || row.mode === "light" ? row.mode : fallback.mode,
    tokens,
    chart,
    recent: Array.isArray(row.recent) ? row.recent.filter((item) => typeof item === "string").slice(0, 12) : [],
    favorites: Array.isArray(row.favorites) ? row.favorites.filter((item) => typeof item === "string").slice(0, 24) : [],
    custom: Array.isArray(row.custom) ? row.custom.flatMap((item) => {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.name !== "string") return [];
      const saved = item as SavedTheme;
      return [{ id: saved.id, name: saved.name.slice(0, 40), mode: saved.mode === "light" ? "light" as const : "dark" as const, tokens: { ...fallback.tokens, ...saved.tokens }, chart: { ...fallback.chart, ...saved.chart } }];
    }) : [],
  };
}

function pickIndicatorPrefs(chart: Partial<ChartPaint> | undefined): Partial<ChartPaint> {
  if (!chart) return {};
  const keep: Partial<ChartPaint> = {};
  if (chart.indicatorWidth != null) keep.indicatorWidth = chart.indicatorWidth;
  if (chart.indicatorOpacity != null) keep.indicatorOpacity = chart.indicatorOpacity;
  if (chart.indicatorStyle != null) keep.indicatorStyle = chart.indicatorStyle;
  return keep;
}

export function loadAppearance(userId = ""): Appearance {
  if (typeof localStorage === "undefined") return emptyAppearance();
  try {
    return normalizeAppearance(JSON.parse(localStorage.getItem(appearanceKey(userId)) || "null"));
  } catch {
    return emptyAppearance();
  }
}

export function saveAppearance(appearance: Appearance, userId = "") {
  if (typeof localStorage === "undefined") return appearance;
  const next = normalizeAppearance(appearance);
  localStorage.setItem(appearanceKey(userId), JSON.stringify(next));
  return next;
}

export function applyAppearance(appearance: Appearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = appearance.mode;
  const map: Record<string, string> = {
    background: appearance.tokens.background,
    panel: appearance.tokens.panel,
    elevated: appearance.tokens.elevated,
    primary: appearance.tokens.primary,
    "on-primary": appearance.tokens.onPrimary,
    profit: appearance.tokens.profit,
    loss: appearance.tokens.loss,
    warning: appearance.tokens.warning,
    info: appearance.tokens.info,
    demo: appearance.tokens.demo,
    text: appearance.tokens.text,
    muted: appearance.tokens.muted,
    border: appearance.tokens.border,
    grid: appearance.tokens.grid,
  };
  for (const [token, value] of Object.entries(map)) root.style.setProperty(`--${token}`, value);
}

export function presetAppearance(id: string, current?: Appearance): Appearance {
  const preset = THEME_PRESETS.find((item) => item.id === id) ?? THEME_PRESETS[0];
  return normalizeAppearance({ ...current, presetId: preset.id, mode: preset.mode, tokens: preset.tokens, chart: preset.chart });
}

export function rememberColor(appearance: Appearance, input: string): Appearance {
  const parsed = parseColor(input);
  if (!parsed.ok) return appearance;
  return { ...appearance, recent: [parsed.hex, ...appearance.recent.filter((item) => item !== parsed.hex)].slice(0, 12) };
}

export function toggleFavorite(appearance: Appearance, input: string): Appearance {
  const parsed = parseColor(input);
  if (!parsed.ok) return appearance;
  const has = appearance.favorites.includes(parsed.hex);
  return { ...appearance, favorites: has ? appearance.favorites.filter((item) => item !== parsed.hex) : [parsed.hex, ...appearance.favorites].slice(0, 24) };
}

export const OPACITY_STOPS = [0.1, 0.25, 0.5, 0.75, 1] as const;
