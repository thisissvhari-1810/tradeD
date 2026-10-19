"use client";

import { useCallback, useSyncExternalStore } from "react";

export type Layout = "wide" | "medium" | "narrow";

const WIDE = "(min-width: 1280px)";
const MEDIUM = "(min-width: 768px)";

function subscribeMedia(notify: () => void) {
  const queries = [window.matchMedia(WIDE), window.matchMedia(MEDIUM)];
  for (const query of queries) query.addEventListener("change", notify);
  return () => { for (const query of queries) query.removeEventListener("change", notify); };
}

function layoutNow(): Layout {
  if (window.matchMedia(WIDE).matches) return "wide";
  return window.matchMedia(MEDIUM).matches ? "medium" : "narrow";
}

/** Desktop on the server so the first paint matches the most common layout; the client corrects it after hydration. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribeMedia, layoutNow, () => "wide");
}

const VIEW_KEY = "td-multi-account-view";
const listeners = new Set<() => void>();
let memoryView: "grid" | "table" = "grid";

function readView(): "grid" | "table" {
  try {
    const stored = window.localStorage.getItem(VIEW_KEY);
    return stored === "table" || stored === "grid" ? stored : memoryView;
  } catch {
    return memoryView;
  }
}

function subscribeView(notify: () => void) {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => { listeners.delete(notify); window.removeEventListener("storage", notify); };
}

/** Grid/table preference. Only this UI choice is stored; no account data is written to the browser. */
export function useAccountView(): ["grid" | "table", (next: "grid" | "table") => void] {
  const view = useSyncExternalStore(subscribeView, readView, () => "grid" as const);
  const setView = useCallback((next: "grid" | "table") => {
    memoryView = next;
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Storage blocked: the in-memory value still applies for this session.
    }
    for (const notify of listeners) notify();
  }, []);
  return [view, setView];
}
