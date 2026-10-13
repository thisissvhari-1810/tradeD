export const THEMES = [
  { id: "obsidian", name: "Obsidian gold", bg: "#0A0D14", panel: "#141A26", accent: "#D4AF37", ink: "#F8FAFC" },
  { id: "terminal", name: "Blue terminal", bg: "#0B0E11", panel: "#131722", accent: "#2962FF", ink: "#F8FAFC" },
  { id: "amber", name: "Amber tape", bg: "#0C0C0C", panel: "#161616", accent: "#FFB000", ink: "#F8F1DE" },
  { id: "navy", name: "Navy desk", bg: "#0B1220", panel: "#121A2B", accent: "#5B9FFF", ink: "#E8EEF8" },
  { id: "exchange", name: "Day session", bg: "#F3F5F8", panel: "#FFFFFF", accent: "#1D4ED8", ink: "#0F172A" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const THEME_KEY = "tl-theme";

export function applyTheme(id: string) {
  const theme = THEMES.some((item) => item.id === id) ? id : "obsidian";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  return theme;
}

export function themeColor(token: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || fallback;
}

export function withAlpha(hex: string, alpha: number) {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) return hex;
  const value = Number.parseInt(cleaned, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red},${green},${blue},${alpha})`;
}
