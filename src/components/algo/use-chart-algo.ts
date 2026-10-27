"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/components/api";
import { playGate, type PlayGate } from "@/lib/algo/chart-replay";
import { newReplaySession } from "@/lib/options/replay-premium";
import type { AlgoData } from "@/components/algo/algo-panel";
import { readSelectedStrategy, useOnSettingsSaved, useSelectedStrategy } from "@/components/algo/algo-settings-sync";

export type ChartAlgo = ReturnType<typeof useChartAlgo>;

const enabledKey = (user: string) => `td-algo-replay:${user}`;
/** The Algo's own replay session per replay date (separate from the chart's manual option replay session). */
const sessionsKey = (user: string) => `td-algo-sessions:${user}`;

function readSessions(user: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(sessionsKey(user)) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch {
    return {};
  }
}

/** A failed request as shown in the panel: its message and, when the server names one, the field. */
function describe(caught: unknown, fallback: string) {
  const error = caught as { message?: unknown; field?: unknown; code?: unknown } | null;
  const message = typeof error?.message === "string" && error.message ? error.message : fallback;
  const field = typeof error?.field === "string" && error.field ? ` (field: ${error.field})` : "";
  if (process.env.NODE_ENV !== "production") console.error("[algo]", { message, field: error?.field, code: error?.code });
  return `${message}${field}`;
}

/** Algo is on unless the user switched it off (an explicit "0"); a new session turns it on again. */
function readEnabled(user: string) {
  try {
    return localStorage.getItem(enabledKey(user)) !== "0";
  } catch {
    return true;
  }
}

/** Completed sessions whose summary was already shown (once per session, also across refreshes). */
const completedKey = (user: string) => `td-algo-completed:${user}`;
function readShown(user: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(completedKey(user)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(-50) : [];
  } catch {
    return [];
  }
}

/**
 * The Algo inside the chart's replay. The switch ("Enable Algo") is only an intention: nothing trades
 * until the user confirms "Start Algo & Replay", which arms the run on the server. While the replay
 * plays, every new completed minute is sent to the server, one request at a time; the server processes
 * the minutes in order, exactly once, and places any orders on the Algo account's ledger.
 *
 * Session lifecycle: each run has its own session id (one per replay date until it ends). Exit Replay
 * finalizes it on the server (archived to Algo History, a fresh ₹1,00,000 period opened) and only then
 * forgets the id, so the next Play starts a brand-new session. Responses for a session that is no longer
 * the active one are ignored, so a late update can never bring an old session back.
 */
export function useChartAlgo(input: {
  user: string;
  active: boolean;
  /** The replay date (the session is looked up per date). */
  date: string | null;
  cursor: number | null;
  /** Steps are sent while the replay plays (or has just completed at the close). */
  advancing: boolean;
  onLedger: () => void;
  onPause: () => void;
  notify: (message: string, options?: { tone?: "success" | "warning" | "info" }) => void;
  /** The session's trades are all done (archived as COMPLETED): called once per session. */
  onComplete?: (run: NonNullable<AlgoData["chart"]>) => void;
}) {
  const { user, active, date, cursor, advancing } = input;
  const [enabled, setEnabledState] = useState(false);
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (user && loadedFor !== user) {
    setLoadedFor(user);
    setEnabledState(readEnabled(user));
    setSessions(readSessions(user));
  }
  const session = date ? sessions[date] ?? null : null;
  const rememberSession = useCallback((forDate: string, id: string | null) => {
    setSessions((current) => {
      const next = { ...current };
      if (id) next[forDate] = id;
      else delete next[forDate];
      try { localStorage.setItem(sessionsKey(user), JSON.stringify(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  }, [user]);
  const [data, setData] = useState<AlgoData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selected] = useSelectedStrategy();
  const callbacks = useRef(input);
  useEffect(() => { callbacks.current = input; });
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  // A response belongs to the session that was active when it was asked for; it is dropped otherwise.
  const forActive = useCallback((next: AlgoData): AlgoData => (next.chart && next.chart.replaySession !== sessionRef.current ? { ...next, chart: null } : next), []);

  const trades = useRef<{ session: string | null; count: number }>({ session: null, count: 0 });
  const apply = useCallback((raw: AlgoData) => {
    const next = forActive(raw);
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
    // The authoritative completion: the server archived the session as COMPLETED. Shown once per session.
    if (run && run.status === "ENDED" && run.endReason === "COMPLETED") {
      const user = callbacks.current.user;
      const shown = readShown(user);
      if (!shown.includes(run.id)) {
        try { localStorage.setItem(completedKey(user), JSON.stringify([...shown, run.id].slice(-50))); } catch { /* Storage is optional. */ }
        callbacks.current.onComplete?.(run);
      }
    }
  }, [forActive]);

  const load = useCallback(async () => {
    const query = sessionRef.current ? `?session=${encodeURIComponent(sessionRef.current)}` : "";
    try {
      apply(await api<AlgoData>(`/api/algo${query}`));
      setError("");
    } catch (caught) {
      setError(describe(caught, "The algo could not be loaded."));
    }
  }, [apply]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, session, load]);

  // Settings saved in the Strategy drawer's Algo panel: reload them, so the start dialog and the replay panel
  // never show the settings from before the save.
  const reloadSaved = useCallback(() => {
    if (active) void load();
  }, [active, load]);
  useOnSettingsSaved(reloadSaved);

  const command = useCallback(async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try {
      apply(await api<AlgoData>("/api/algo", body));
      setError("");
      return true;
    } catch (caught) {
      setError(describe(caught, "The algo request failed."));
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
      // Only Algo Trade has a live-price mode to switch from; the Primary Strategy is chart replay only.
      if (readSelectedStrategy() === "EXISTING_ALGO" && data?.config.mode !== "REPLAY" && !(await command("mode", { action: "chartMode" }))) return;
      remember(true);
      return;
    }
    remember(false);
    if (sessionRef.current) void command("disarm", { action: "chartDisarm", session: sessionRef.current });
  }, [command, data?.config.mode, remember]);

  // Algo on in the chart's replay means it trades the replay: an idle Algo still set to live-price paper
  // trading is switched to chart replay once (never while a live-price session or position is active).
  const switched = useRef(false);
  useEffect(() => {
    if (!active || !enabled || !data || switched.current || data.config.mode === "REPLAY" || readSelectedStrategy() !== "EXISTING_ALGO") return;
    if (data.state.running || data.state.position || data.state.pending) return;
    switched.current = true;
    // Run after this effect (the request updates state).
    queueMicrotask(() => void command("mode", { action: "chartMode" }));
  }, [active, enabled, data, command]);

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
    const asked = session;
    api<AlgoData>("/api/algo", { action: "chartStep", session, cursor: Math.floor(cursor) })
      .then((next) => {
        // A step that comes back after its session ended (or was replaced) changes nothing.
        if (sessionRef.current !== asked) return;
        failures.current = 0;
        setError("");
        apply(next);
      })
      .catch((caught: unknown) => {
        const message = describe(caught, "The algo update failed.");
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

  /** Drops the active session on this device (it is already archived): the next Play starts a new one, with Algo on. */
  const forgetSession = useCallback(() => {
    if (!date) return;
    sessionRef.current = null;
    rememberSession(date, null);
    setData((current) => (current ? { ...current, chart: null } : current));
    trades.current = { session: null, count: 0 };
    remember(true);
    void load();
  }, [date, load, remember, rememberSession]);

  const endSession = useCallback(async (label: string, action: "chartFinalize" | "chartReset") => {
    const id = sessionRef.current;
    if (!id || !date) return true;
    const ok = await command(label, { action, session: id });
    if (!ok) return false;
    forgetSession();
    return true;
  }, [command, date, forgetSession]);

  // Ready to trade the replay: Algo Trade in chart-replay mode, or Algo - Primary Strategy (chart replay only).
  // Mathi 5% runs the same rules on the replay with its own settings (always chart replay there).
  const replayReady = selected === "PRIMARY_STRATEGY" || selected === "MATHI_5" || run?.strategy === "PRIMARY_STRATEGY" || run?.strategy === "MATHI_5" || data?.config.mode === "REPLAY";
  const gate: PlayGate | null = cursor == null ? null : playGate({
    algoEnabled: enabled && replayReady,
    cursor,
    processedThrough: run && run.replaySession === session && run.status === "ACTIVE" ? run.processedThrough : null,
  });

  return {
    enabled,
    replayReady,
    setEnabled,
    data,
    run: run && run.replaySession === session ? run : null,
    error,
    busy,
    gate,
    clearError: () => setError(""),
    refresh: load,
    /** Confirms the run, starting a brand-new session (new id, fresh ₹1,00,000 period) when none is active. */
    arm: (at: number) => {
      if (!date) return Promise.resolve(false);
      let id = session;
      if (!id) {
        id = newReplaySession(date);
        sessionRef.current = id;
        rememberSession(date, id);
      }
      // The selected feature arms the run; the server refuses it while the other one holds the execution lock.
      return command("arm", { action: "chartArm", session: id, cursor: Math.floor(at), strategy: readSelectedStrategy() });
    },
    /** The active session has anything to archive (it ran, or traded, or holds a position). */
    hasSession: Boolean(session && run),
    exit: (at: number, emergency = false) => (session ? command(emergency ? "emergency" : "exit", { action: "chartExit", session, cursor: Math.floor(at), ...(emergency ? { emergency: true } : {}) }) : Promise.resolve(false)),
    disarm: () => (session ? command("disarm", { action: "chartDisarm", session }) : Promise.resolve(false)),
    reset: () => endSession("reset", "chartReset"),
    /**
     * Exit Replay: archives the session on the server (open position closed at the last replay premium, or
     * kept as unresolved), then forgets it. The data stays on screen until the archive has succeeded.
     */
    finalize: () => endSession("finalize", "chartFinalize"),
    /** After a completed session (already archived on the server): start over with a brand-new session. */
    startNew: forgetSession,
  };
}
