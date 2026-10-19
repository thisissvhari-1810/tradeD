"use client";

import { useSyncExternalStore } from "react";
import type { CursorStyle, MagnetMode } from "@/components/drawing-model";
import { TOOL_GROUPS, toolEntry } from "@/components/drawing-tools";

export type DrawingPrefs = {
  favourites: string[];
  favBar: { x: number; y: number };
  stay: boolean;
  magnet: MagnetMode;
  cursor: CursorStyle;
  last: Record<string, string>;
};

const KEY = "td-draw-prefs";

export const DEFAULT_PREFS: DrawingPrefs = {
  favourites: [],
  favBar: { x: 12, y: 12 },
  stay: true,
  magnet: "off",
  cursor: "cross",
  last: {},
};

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: DrawingPrefs = DEFAULT_PREFS;

export function parsePrefs(raw: string | null): DrawingPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return DEFAULT_PREFS;
    const row = value as Partial<Record<keyof DrawingPrefs, unknown>>;
    const favourites = Array.isArray(row.favourites)
      ? [...new Set(row.favourites.filter((item): item is string => typeof item === "string" && toolEntry(item) != null))].slice(0, 24)
      : [];
    const bar = row.favBar && typeof row.favBar === "object" ? row.favBar as { x?: unknown; y?: unknown } : {};
    const favBar = {
      x: typeof bar.x === "number" && Number.isFinite(bar.x) ? bar.x : DEFAULT_PREFS.favBar.x,
      y: typeof bar.y === "number" && Number.isFinite(bar.y) ? bar.y : DEFAULT_PREFS.favBar.y,
    };
    const magnet = row.magnet === "weak" || row.magnet === "strong" ? row.magnet : "off";
    const cursor = row.cursor === "dot" || row.cursor === "arrow" ? row.cursor : "cross";
    const groups = new Set(TOOL_GROUPS.map((group) => group.id));
    const last: Record<string, string> = {};
    if (row.last && typeof row.last === "object") {
      for (const [group, key] of Object.entries(row.last as Record<string, unknown>)) {
        if (groups.has(group) && typeof key === "string" && toolEntry(key)) last[group] = key;
      }
    }
    return { favourites, favBar, stay: row.stay === false ? false : true, magnet, cursor, last };
  } catch {
    return DEFAULT_PREFS;
  }
}

let memory: string | null = null;

function readRaw() {
  if (memory != null) return memory;
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
    cached = parsePrefs(raw);
  }
  return cached;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function updatePrefs(patch: Partial<DrawingPrefs> | ((current: DrawingPrefs) => Partial<DrawingPrefs>)) {
  const current = snapshot();
  const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    memory = JSON.stringify(next);
  }
  for (const listener of listeners) listener();
}

export function useDrawingPrefs() {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PREFS);
}

export function toggleFavourite(key: string) {
  updatePrefs((current) => ({
    favourites: current.favourites.includes(key) ? current.favourites.filter((item) => item !== key) : [...current.favourites, key],
  }));
}

export function moveFavourite(key: string, before: string | null) {
  updatePrefs((current) => {
    const rest = current.favourites.filter((item) => item !== key);
    const index = before ? rest.indexOf(before) : -1;
    if (index < 0) rest.push(key);
    else rest.splice(index, 0, key);
    return { favourites: rest };
  });
}
