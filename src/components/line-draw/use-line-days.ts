"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/components/api";
import type { Candle } from "@/lib/algo/lines";
import type { LineDay } from "@/lib/chart/line-drawings";
import type { S1Data } from "@/lib/trading/s1";

export type DayRequest = { key: string; symbol: string; date: string | null; previous: string | null; tape: boolean; vix?: boolean };
export type DayEntry = { day: LineDay | null; error: string; at: number };

/**
 * Session data for Line Strategy Draw, one request per distinct (symbol, current day, previous day, candles) — strategies
 * on the same days share it. Live (current day on Auto) refreshes each minute so the open, 09:15, hourly and 13:15
 * levels appear once they exist; a chosen past day is loaded once.
 */
export function useLineDays(requests: DayRequest[]) {
  const [entries, setEntries] = useState<Record<string, DayEntry>>({});
  const signature = useMemo(() => [...new Set(requests.map((item) => item.key))].sort().join(","), [requests]);
  const wanted = useMemo(() => {
    const byKey = new Map(requests.map((item) => [item.key, item]));
    return signature ? signature.split(",").map((key) => byKey.get(key)!).filter(Boolean) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    if (!wanted.length) return;
    let stop = false;
    const load = (request: DayRequest) => {
      const params = new URLSearchParams({ symbol: request.symbol });
      if (request.date) params.set("date", request.date);
      if (request.previous) params.set("previous", request.previous);
      if (request.tape) params.set("tape", "1");
      if (request.vix) params.set("vix", "1");
      api<S1Data & { tape?: Candle[]; vix?: Candle[] }>(`/api/market/levels?${params}`)
        .then(({ tape, vix, ...data }) => {
          if (!stop) setEntries((current) => ({ ...current, [request.key]: { day: { data, tape: tape ?? null, vix: vix ?? null }, error: "", at: Math.floor(Date.now() / 1000) } }));
        })
        .catch((reason: unknown) => {
          if (!stop) {
            setEntries((current) => ({
              ...current,
              [request.key]: { day: current[request.key]?.day ?? null, error: reason instanceof Error ? reason.message : "Levels could not be loaded.", at: current[request.key]?.at ?? Math.floor(Date.now() / 1000) },
            }));
          }
        });
    };
    wanted.forEach(load);
    const live = wanted.filter((item) => !item.date);
    const timer = live.length ? window.setInterval(() => live.forEach(load), 60_000) : null;
    return () => {
      stop = true;
      if (timer) window.clearInterval(timer);
    };
  }, [wanted]);

  return entries;
}
