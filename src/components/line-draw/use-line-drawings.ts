"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/components/api";
import type { LineDrawing } from "@/lib/chart/line-drawings";
import type { LineDrawingAction } from "@/server/chart-lines";

/**
 * The signed-in user's saved Line Strategy Draw drawings, loaded from and saved to the server (/api/chart-lines).
 * Visibility toggles update the screen at once and are then saved; any failure reloads the saved list, so the
 * screen never keeps a change the server refused.
 */
export function useLineDrawings() {
  const [drawings, setDrawings] = useState<LineDrawing[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);

  const reload = useCallback(() => {
    api<{ drawings: LineDrawing[] }>("/api/chart-lines")
      .then((data) => { if (alive.current) { setDrawings(data.drawings); setError(""); } })
      .catch((reason: unknown) => { if (alive.current) setError(reason instanceof Error ? reason.message : "Saved line drawings could not be loaded."); })
      .finally(() => { if (alive.current) setLoaded(true); });
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => { alive.current = false; };
  }, [reload]);

  const run = useCallback(async (action: LineDrawingAction) => {
    if (action.action === "update" && action.enabled !== undefined && Object.keys(action).length === 3) {
      setDrawings((list) => list.map((item) => (item.id === action.id ? { ...item, enabled: Boolean(action.enabled) } : item)));
    } else if (action.action === "set-all") {
      setDrawings((list) => list.map((item) => (!action.symbol || item.symbol === "*" || item.symbol === action.symbol ? { ...item, enabled: action.enabled } : item)));
    }
    setBusy(true);
    setError("");
    try {
      const data = await api<{ drawings: LineDrawing[] }>("/api/chart-lines", action);
      if (alive.current) setDrawings(data.drawings);
      return true;
    } catch (reason) {
      if (alive.current) {
        setError(reason instanceof Error ? reason.message : "The change was not saved.");
        reload();
      }
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [reload]);

  /** Changes a drawing on screen only (the caller saves it with run); used while edits are being collected. */
  const patch = useCallback((id: string, change: Partial<LineDrawing>) => {
    setDrawings((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  return { drawings, loaded, busy, error, run, patch };
}
