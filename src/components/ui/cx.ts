export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export type Tone = "neutral" | "primary" | "profit" | "loss" | "warning" | "info" | "demo";

/** Sign and arrow so direction never depends on colour alone. */
export function signed(value: number | null | undefined, digits = 2, unit = "") {
  if (value == null || !Number.isFinite(value)) return "—";
  const body = Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (value === 0) return `${unit}${body}`;
  return `${value > 0 ? "▲ +" : "▼ −"}${unit}${body}`;
}

export function toneOf(value: number | null | undefined): Tone {
  if (value == null || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "profit" : "loss";
}

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  primary: "text-primary",
  profit: "text-profit",
  loss: "text-loss",
  warning: "text-warning",
  info: "text-info",
  demo: "text-demo",
};
