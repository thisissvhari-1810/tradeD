"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/components/api";

export const inr = (value: number | null | undefined, sign = true) =>
  value == null ? "—" : `${sign && value > 0 ? "+" : value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const money = (value: number | null | undefined) => inr(value, false);
export const tone = (value: number | null | undefined) => (value == null || value === 0 ? "text-text" : value > 0 ? "text-profit" : "text-loss");
export const time = (value: string | Date | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "—";
export const clockOf = (minute: number | null | undefined) => (minute == null ? "—" : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);

export const STATUS_TONE: Record<string, "neutral" | "primary" | "profit" | "loss" | "warning" | "info"> = {
  WAITING: "neutral", WATCHING: "info", IN_TRADE: "primary", NO_TRADE: "neutral", DONE: "profit", CLOSED: "neutral", OPEN: "primary", EXITING: "warning",
};

/** The current time, refreshed every `ms` (render code must not call Date.now() itself). */
export function useNow(ms = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** Polls a JSON endpoint every `ms` while the page is visible (the engine runs on the server; this only shows it). */
export function usePoll<T>(path: string | null, ms = 5_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const load = useCallback(() => {
    if (!path) return;
    api<T>(path)
      .then((next) => { if (alive.current) { setData(next); setError(""); } })
      .catch((reason: unknown) => { if (alive.current) setError(reason instanceof Error ? reason.message : "Could not load."); });
  }, [path]);
  useEffect(() => {
    alive.current = true;
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, ms);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [load, ms]);
  return { data, error, reload: load, setData };
}
