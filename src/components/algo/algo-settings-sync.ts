"use client";

import { useEffect, useState } from "react";
import type { AlgoStrategy } from "@/lib/algo/exclusive";

/**
 * Keeps the chart's Algo (start dialog, replay panel) in step with the Algo settings panel in the Strategy
 * drawer: a save tells the chart to reload the saved settings, and unsaved edits are flagged so the start
 * dialog can say the replay uses the saved settings, not the ones still being edited.
 */
const SAVED = "td-algo-settings-saved";
const DIRTY = "td-algo-settings-dirty";
let unsaved = false;

export function announceSaved() {
  window.dispatchEvent(new Event(SAVED));
}

export function announceUnsaved(next: boolean) {
  if (next === unsaved) return;
  unsaved = next;
  window.dispatchEvent(new Event(DIRTY));
}

export function useOnSettingsSaved(callback: () => void) {
  useEffect(() => {
    window.addEventListener(SAVED, callback);
    return () => window.removeEventListener(SAVED, callback);
  }, [callback]);
}

export function useUnsavedSettings() {
  const [value, setValue] = useState(unsaved);
  useEffect(() => {
    const update = () => setValue(unsaved);
    update();
    window.addEventListener(DIRTY, update);
    return () => window.removeEventListener(DIRTY, update);
  }, []);
  return value;
}

/**
 * Which algo feature the panels show and the chart starts: Algo Trade or Algo - Primary Strategy. Selecting
 * one never starts it, and the server's execution lock — not this choice — decides who may place orders.
 */
const SELECTED_KEY = "td-algo-strategy";
const SELECTED = "td-algo-strategy-change";

export function readSelectedStrategy(): AlgoStrategy {
  try {
    const saved = localStorage.getItem(SELECTED_KEY);
    return saved === "PRIMARY_STRATEGY" || saved === "MATHI_5" ? saved : "EXISTING_ALGO";
  } catch {
    return "EXISTING_ALGO";
  }
}

export function useSelectedStrategy(): [AlgoStrategy, (next: AlgoStrategy) => void] {
  const [value, setValue] = useState<AlgoStrategy>("EXISTING_ALGO");
  useEffect(() => {
    const update = () => setValue(readSelectedStrategy());
    update();
    window.addEventListener(SELECTED, update);
    return () => window.removeEventListener(SELECTED, update);
  }, []);
  const select = (next: AlgoStrategy) => {
    try { localStorage.setItem(SELECTED_KEY, next); } catch { /* Storage is optional. */ }
    window.dispatchEvent(new Event(SELECTED));
  };
  return [value, select];
}
