"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/components/api";
import { playGate, type PlayGate } from "@/lib/algo/chart-replay";
import type { AlgoData } from "@/components/algo/algo-panel";

export type ChartAlgo = ReturnType<typeof useChartAlgo>;

const enabledKey = (user: string) => `td-algo-replay:${user}`;

function readEnabled(user: string) {
  try {
    return localStorage.getItem(enabledKey(user)) === "1";
  } catch {
    return false;
  }
}

/**
 * The Algo inside the chart's replay. The switch ("Enable Algo") is only an intention: nothing trades
 * until the user confirms "Start Algo & Replay", which arms the run on the server. While the replay
 * plays, every new completed minute is sent to the server, one request at a time; the server processes
 * the minutes in order, exactly once, and places any orders on the demo ledger.
 */
export function useChartAlgo(input: {
  user: string;
  active: boolean;
  session: string | null;
  cursor: number | null;
  /** Steps are sent while the replay plays (or has just completed at the close). */
  advancing: boolean;
  onLedger: () => void;
  onPause: () => void;
  notify: (message: string, options?: { tone?: "success" | "warning" | "info" }) => void;
}) {
  const { user, active, session, cursor, advancing } = input;
  const [enabled, setEnabledState] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (user && loadedFor !== user) {
    setLoadedFor(user);
    setEnabledState(readEnabled(user));
  }
  const [data, setData] = useState<AlgoData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const callbacks = useRef(input);
  useEffect(() => { callbacks.current = input; });
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  const trades = useRef<{ session: string | null; count: number }>({ session: null, count: 0 });
  const apply = useCallback((next: AlgoData) => {
    setData(next);
    const run = next.chart;
    const count = run ? run.events.filter((event) => event.kind === "ENTRY" || event.kind === "EXIT").length : 0;
    const seen = trades.current;
    if (run && seen.session === run.replaySession && count > seen.count) {
      const fresh = run.events.filter((event) => event.kind === "ENTRY" || event.kind === "EXIT").slice(seen.count);
      for (const event of fresh) callbacks.current.notify(`Algo: ${event.message}`, { tone: event.kind === "EXIT" ? ((event.pnl ?? 0) >= 0 ? "success" : "warning") : "info" });
      callbacks.current.onLedger();
    }
    trades.current = { session: run?.replaySession ?? null, count };
  }, []);

  const load = useCallback(async () => {
    const query = sessionRef.current ? `?session=${encodeURIComponent(sessionRef.current)}` : "";
    try {
      apply(await api<AlgoData>(`/api/algo${query}`));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The algo could not be loaded.");
    }
  }, [apply]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, session, load]);

  const command = useCallback(async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try {
      apply(await api<AlgoData>("/api/algo", body));
      setError("");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The algo request failed.");
      return false;
    } finally {
      setBusy("");
    }
  }, [apply]);

  const remember = useCallback((next: boolean) => {
    setEnabledState(next);
    try { localStorage.setItem(enabledKey(user), next ? "1" : "0"); } catch { /* Storage is optional. */ }
  }, [user]);

  /**
   * Enabling in the chart's replay switches the Algo to chart replay on the server first (a live-price
   * paper session is stopped; an open live-price position refuses with its reason), so the chart and the
   * Algo never run on different clocks. The replay pauses: Play then asks for confirmation.
   */
  const setEnabled = useCallback(async (next: boolean) => {
    if (next) {
      callbacks.current.onPause();
      if (data?.config.mode !== "REPLAY" && !(await command("mode", { action: "chartMode" }))) return;
      remember(true);
      return;
    }
    remember(false);
    if (sessionRef.current) void command("disarm", { action: "chartDisarm", session: sessionRef.current });
  }, [command, data?.config.mode, remember]);

  // One step at a time: each sends the replay time; the server processes every minute completed since.
  const stepping = useRef(false);
  const failures = useRef(0);
  const minute = cursor == null ? null : Math.floor(cursor / 60);
  const run = data?.chart ?? null;
  const tracking = Boolean(active && session && run && run.replaySession === session && run.status === "ACTIVE" && (run.armed || run.state.position || run.state.pending));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!tracking || !advancing || minute == null || stepping.current || !session || cursor == null) return;
    if (run && minute * 60 <= run.processedThrough) return;
    stepping.current = true;
    let wait = 0;
    api<AlgoData>("/api/algo", { action: "chartStep", session, cursor })
      .then((next) => {
        failures.current = 0;
        setError("");
        apply(next);
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : "The algo update failed.";
        wait = 1_500;
        if (/busy/i.test(message)) return;
        failures.current += 1;
        // Minutes are never skipped (the next step catches up). Every failure is shown; after a second one
        // the replay pauses, because the position is not protected while updates fail.
        setError(`Algo update failed: ${message}${failures.current >= 2 ? " The replay was paused; press Play to retry." : " Retrying."}`);
        if (failures.current >= 2) callbacks.current.onPause();
      })
      .finally(() => {
        // The next step goes out once this one is back (after a pause when it failed).
        window.setTimeout(() => {
          stepping.current = false;
          setRetry((value) => value + 1);
        }, wait);
      });
  }, [tracking, advancing, minute, session, cursor, run, apply, retry]);

  const gate: PlayGate | null = cursor == null ? null : playGate({
    algoEnabled: enabled && data?.config.mode === "REPLAY",
    cursor,
    processedThrough: run && run.replaySession === session && run.status === "ACTIVE" ? run.processedThrough : null,
  });

  return {
    enabled,
    setEnabled,
    data,
    run: run && run.replaySession === session ? run : null,
    error,
    busy,
    gate,
    clearError: () => setError(""),
    refresh: load,
    /** Confirms the run; `forSession` is the replay session just created for a first run. */
    arm: (at: number, forSession: string | null = session) => (forSession ? command("arm", { action: "chartArm", session: forSession, cursor: at }) : Promise.resolve(false)),
    exit: (at: number, emergency = false) => (session ? command(emergency ? "emergency" : "exit", { action: "chartExit", session, cursor: at, ...(emergency ? { emergency: true } : {}) }) : Promise.resolve(false)),
    disarm: () => (session ? command("disarm", { action: "chartDisarm", session }) : Promise.resolve(false)),
    reset: () => (session ? command("reset", { action: "chartReset", session }) : Promise.resolve(false)),
  };
}
