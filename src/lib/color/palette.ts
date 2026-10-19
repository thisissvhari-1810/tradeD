export type Rgb = { r: number; g: number; b: number };

const FAMILY_BASE: Array<{ id: string; name: string; base: string }> = [
  { id: "red", name: "Red", base: "#EF4444" },
  { id: "orange", name: "Orange", base: "#F97316" },
  { id: "amber", name: "Amber", base: "#F59E0B" },
  { id: "yellow", name: "Yellow", base: "#EAB308" },
  { id: "lime", name: "Lime", base: "#84CC16" },
  { id: "green", name: "Green", base: "#22C55E" },
  { id: "emerald", name: "Emerald", base: "#10B981" },
  { id: "teal", name: "Teal", base: "#14B8A6" },
  { id: "cyan", name: "Cyan", base: "#06B6D4" },
  { id: "sky", name: "Sky blue", base: "#0EA5E9" },
  { id: "blue", name: "Blue", base: "#3B82F6" },
  { id: "indigo", name: "Indigo", base: "#6366F1" },
  { id: "violet", name: "Violet", base: "#8B5CF6" },
  { id: "purple", name: "Purple", base: "#A855F7" },
  { id: "magenta", name: "Magenta", base: "#D946EF" },
  { id: "pink", name: "Pink", base: "#EC4899" },
  { id: "rose", name: "Rose", base: "#F43F5E" },
  { id: "brown", name: "Brown", base: "#92400E" },
  { id: "slate", name: "Slate", base: "#64748B" },
  { id: "gray", name: "Gray", base: "#6B7280" },
  { id: "black", name: "Black", base: "#171717" },
  { id: "white", name: "White", base: "#F8FAFC" },
];

export type Swatch = { name: string; hex: string };
export type ColorFamily = { id: string; name: string; shades: Swatch[] };

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function parseHex(input: string): Rgb | null {
  const raw = input.trim().replace(/^#/, "");
  const hex = raw.length === 3 ? raw.split("").map((part) => part + part).join("") : raw.length === 8 ? raw.slice(0, 6) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function toHex(rgb: Rgb): string {
  const part = (value: number) => clampByte(value).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`.toUpperCase();
}

function mix(base: string, target: string, amount: number): string {
  const from = parseHex(base);
  const into = parseHex(target);
  if (!from || !into) return base.toUpperCase();
  return toHex({
    r: from.r + (into.r - from.r) * amount,
    g: from.g + (into.g - from.g) * amount,
    b: from.b + (into.b - from.b) * amount,
  });
}

function familyShades(name: string, base: string): Swatch[] {
  const lights = [0.78, 0.58, 0.38, 0.18].map((amount, index) => ({ name: `${name} ${index + 1}`, hex: mix(base, "#FFFFFF", amount) }));
  const darks = [0.18, 0.36, 0.52, 0.68, 0.82].map((amount, index) => ({ name: `${name} ${index + 6}`, hex: mix(base, "#0B0E14", amount) }));
  return [...lights, { name: `${name} 5`, hex: toHex(parseHex(base) ?? { r: 0, g: 0, b: 0 }) }, ...darks];
}

export const COLOR_FAMILIES: ColorFamily[] = FAMILY_BASE.map((family) => ({
  id: family.id,
  name: family.name,
  shades: familyShades(family.name, family.base),
}));

export function parseColor(input: string): { ok: true; hex: string } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter a colour." };
  const hex = parseHex(text);
  if (hex && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(text)) return { ok: true, hex: toHex(hex) };
  const rgb = text.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i);
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (channels.some((channel) => channel > 255)) return { ok: false, error: "RGB channels must be from 0 to 255." };
    return { ok: true, hex: toHex({ r: channels[0], g: channels[1], b: channels[2] }) };
  }
  const hsl = text.match(/^hsla?\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)%?\s*[, ]\s*(\d+(?:\.\d+)?)%?/i);
  if (hsl) return { ok: true, hex: toHex(hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]))) };
  return { ok: false, error: "Use a HEX colour such as #4C8DFF, or rgb() / hsl()." };
}

export function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  if (s === 0) {
    const gray = l * 255;
    return { r: gray, g: gray, b: gray };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (amount: number) => {
    let t = amount;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 };
}

export function rgbToHsl(rgb: Rgb): { h: number; s: number; l: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) };
}
