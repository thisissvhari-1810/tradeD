"use client";

import { useSyncExternalStore } from "react";
import { toolEntry } from "@/components/drawing-tools";

/**
 * "Mobile & compact mode" preferences, kept in this browser (no account data, nothing sensitive).
 * Every field changes the phone layout: see where each is read (chart desk, shell, home).
 */
export type MobilePrefs = {
  /** Compact: smaller header and bottom bar on phones. Comfortable: the roomier default sizes. */
  density: "compact" | "comfortable";
  /** Labels under the bottom bar's icons. */
  navLabels: boolean;
  /** Drawing tools shown in the chart's quick toolbar on phones (the rest are under More). */
  quickTools: string[];
  /** Names under the quick toolbar's icons. */
  toolLabels: boolean;
  /** The OHLC / volume readout box at the top of the chart on phones. */
  chartLegend: boolean;
  /** Home on phones: market pulse, movers and shortcut cards (the account and watchlist always show). */
  homeMarketCards: boolean;
};

export const QUICK_TOOL_CHOICES = ["trend", "hline", "hray", "ray", "vline", "rect", "fib", "channel", "long", "short", "text", "measure", "eraser"] as const;

export const MOBILE_DEFAULTS: MobilePrefs = {
  density: "compact",
  navLabels: true,
  quickTools: ["trend", "hline", "hray", "rect", "fib", "eraser"],
  toolLabels: false,
  chartLegend: true,
  homeMarketCards: true,
};

const KEY = "td-mobile-prefs";

export function parseMobilePrefs(raw: string | null): MobilePrefs {
  if (!raw) return MOBILE_DEFAULTS;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof MobilePrefs, unknown>> | null;
    if (!value || typeof value !== "object") return MOBILE_DEFAULTS;
    const bool = (key: keyof MobilePrefs) => (typeof value[key] === "boolean" ? value[key] as boolean : MOBILE_DEFAULTS[key] as boolean);
    const quickTools = Array.isArray(value.quickTools)
      ? [...new Set(value.quickTools.filter((item): item is string => typeof item === "string" && toolEntry(item) != null))].slice(0, 8)
      : MOBILE_DEFAULTS.quickTools;
    return {
      density: value.density === "comfortable" ? "comfortable" : "compact",
      navLabels: bool("navLabels"),
      quickTools,
      toolLabels: bool("toolLabels"),
      chartLegend: bool("chartLegend"),
      homeMarketCards: bool("homeMarketCards"),
    };
  } catch {
    return MOBILE_DEFAULTS;
  }
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached = MOBILE_DEFAULTS;

function readRaw() {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function snapshot() {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseMobilePrefs(raw);
  }
  return cached;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useMobilePrefs() {
  return useSyncExternalStore(subscribe, snapshot, () => MOBILE_DEFAULTS);
}

export function updateMobilePrefs(patch: Partial<MobilePrefs>) {
  const next = { ...snapshot(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the change lasts until the page reloads */
    cachedRaw = JSON.stringify(next);
    cached = next;
  }
  for (const listener of listeners) listener();
}

export function resetMobilePrefs() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  cachedRaw = undefined;
  for (const listener of listeners) listener();
}
