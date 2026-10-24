import { DEFAULT_THEME, type AcademyTheme } from "@/lib/academy/themes";
import { CHAPTERS } from "@/lib/academy/world";
import { THEME } from "../world-art";

/**
 * The four Academy map worlds. Each is only a look for the same roadmap: the same chapters (one per
 * curriculum unit, in order), stops, unlock rules and progress. The colours here are illustration
 * palettes for the world scenes; the app's interface keeps its own theme tokens.
 */

export type RoadStyle = "road" | "transit" | "orbit" | "trace";
export type TransitionStyle = "clouds" | "mist" | "nebula" | "scan";
export type Region = { ground: [string, string]; accent: string; face: [string, string]; rim: string };

export type WorldDef = {
  id: AcademyTheme;
  name: string;
  tagline: string;
  description: string;
  /** One name per chapter (unit order). */
  chapters: string[];
  region: (index: number) => Region;
  fog: [string, string];
  road: RoadStyle;
  transition: TransitionStyle;
};

const pick = <T,>(items: T[], index: number) => items[index % items.length];

// Gold means "completed" on every map, so no world uses it (or amber) for a playable stop.
const METRO_ACCENTS = ["#3fe08d", "#38e1ff", "#b79bff", "#3fe08d", "#38e1ff", "#b79bff", "#3fe08d"];
const COSMOS_ACCENTS = ["#38e1ff", "#b79bff", "#3fe08d", "#38e1ff", "#b79bff", "#3fe08d", "#38e1ff"];
const CIRCUIT_ACCENTS = ["#38e1ff", "#3fe08d", "#38e1ff", "#b79bff", "#3fe08d", "#38e1ff", "#3fe08d"];
const FACE: Record<string, [string, string, string]> = {
  "#3fe08d": ["#8ff5bf", "#1fae63", "#11804a"],
  "#ffc83d": ["#ffe49a", "#e3a42a", "#9a6a00"],
  "#38e1ff": ["#9ff0ff", "#1aa6d6", "#0d6a8f"],
  "#b79bff": ["#dccbff", "#8a5cf6", "#4b2fa8"],
  "#ffb547": ["#ffd89a", "#f08a1c", "#9a5200"],
};
const face = (accent: string): Pick<Region, "face" | "rim"> => ({ face: [FACE[accent][0], FACE[accent][1]], rim: FACE[accent][2] });

export const WORLDS: Record<AcademyTheme, WorldDef> = {
  metropolis: {
    id: "metropolis",
    name: "Market Metropolis",
    tagline: "A living financial city",
    description: "Skyscrapers, exchange towers and glowing market screens, linked by a city transit line.",
    chapters: ["Stock Market Square", "Candlestick Plaza", "Trend Avenue", "Indicator Heights", "Risk Vault District", "Options Exchange Tower", "Trading Champions Arena"],
    region: (index) => {
      const accent = pick(METRO_ACCENTS, index);
      const grounds: Array<[string, string]> = [["#0b1a33", "#0f3046"], ["#0d1b36", "#16324f"], ["#0a1d2f", "#0f3a44"], ["#0e1838", "#1b2c55"], ["#0b1a2c", "#173246"], ["#0c1a36", "#123b4f"], ["#101634", "#24305a"]];
      return { ground: pick(grounds, index), accent, ...face(accent) };
    },
    fog: ["#1a2c4a", "#0c1526"],
    road: "transit",
    transition: "mist",
  },
  cosmos: {
    id: "cosmos",
    name: "Candlestick Cosmos",
    tagline: "Explore the market universe",
    description: "Trading planets, chart-shaped constellations and orbiting candles along a glowing price trajectory.",
    chapters: ["Bull and Bear Orbit", "Candle Nebula", "Support Planet", "Trend Observatory", "Risk Control Station", "Options Galaxy", "Strategy Starbase"],
    region: (index) => {
      const accent = pick(COSMOS_ACCENTS, index);
      const grounds: Array<[string, string]> = [["#090a26", "#18124a"], ["#0b0a2a", "#241452"], ["#08102a", "#10244a"], ["#0c0b2e", "#1e1a5a"], ["#0a0c26", "#1a2048"], ["#0d0a2c", "#2a1656"], ["#070d24", "#13284a"]];
      return { ground: pick(grounds, index), accent, ...face(accent) };
    },
    fog: ["#1c1846", "#090a1f"],
    road: "orbit",
    transition: "nebula",
  },
  circuit: {
    id: "circuit",
    name: "Trading Circuit",
    tagline: "A cyber-finance network",
    description: "Trading terminals, data bridges and order books, where finished lessons switch the circuit on.",
    chapters: ["Market Network", "Candle Analysis Lab", "Trend Engine", "Signal Processor", "Risk Management Core", "Options Terminal", "Strategy Mainframe"],
    region: (index) => {
      const accent = pick(CIRCUIT_ACCENTS, index);
      const grounds: Array<[string, string]> = [["#0c1117", "#131c27"], ["#0d1218", "#16202b"], ["#0b1016", "#121d24"], ["#0e1117", "#1b1d26"], ["#0c1116", "#13211f"], ["#0c1018", "#141c2c"], ["#0b0f15", "#131b22"]];
      return { ground: pick(grounds, index), accent, ...face(accent) };
    },
    fog: ["#141b25", "#090c11"],
    road: "trace",
    transition: "scan",
  },
  expedition: {
    id: "expedition",
    name: "Market Expedition",
    tagline: "An illustrated trading journey",
    description: "From Market City to Strategy Summit: canyons, forests, harbours and fortresses, each one a trading idea.",
    chapters: CHAPTERS.map((chapter) => chapter.name),
    region: (index) => {
      const theme = THEME[CHAPTERS[Math.min(index, CHAPTERS.length - 1)].theme];
      return { ground: theme.ground, accent: theme.accent, face: theme.face, rim: theme.rim };
    },
    fog: ["#33476b", "#1c2740"],
    road: "road",
    transition: "clouds",
  },
};

export function worldOf(theme: AcademyTheme | null | undefined): WorldDef {
  return WORLDS[theme ?? DEFAULT_THEME] ?? WORLDS[DEFAULT_THEME];
}
