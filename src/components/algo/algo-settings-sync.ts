"use client";

import { useEffect, useState } from "react";

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
