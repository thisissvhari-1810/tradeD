"use client";

import { useEffect, useRef, useState } from "react";
import { intervalVolume } from "@/lib/market/feed";

export type FeedState = "connecting" | "live" | "delayed" | "reconnecting" | "disconnected" | "historical";

export type FeedTick = { price: number; time: number; volumeDelta: number; dayVolume: number | null };

export function feedStatusLabel(status: FeedState) {
  if (status === "connecting") return "Connecting";
  if (status === "live") return "Live";
  if (status === "delayed") return "Delayed";
  if (status === "reconnecting") return "Reconnecting";
  if (status === "disconnected") return "Disconnected";
  return "Historical";
}

export function segmentLabel(segment: string) {
  if (segment === "IDX_I") return "Index";
  if (segment === "NSE_EQ") return "NSE cash";
  return segment;
}

export function useMarketStream(symbol: string, enabled: boolean, onTick: (tick: FeedTick) => void) {
  const [state, setState] = useState<Exclude<FeedState, "delayed">>(enabled ? "connecting" : "historical");
  const [detail, setDetail] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!enabled || !symbol) {
      setState("historical");
      setDetail("");
      setUpdatedAt(null);
      return;
    }
    let source: EventSource | null = null;
    let timer = 0;
    let stop = false;
    let attempt = 0;
    let baseline: number | null = null;
    const open = () => {
      if (stop) return;
      setState(attempt ? "reconnecting" : "connecting");
      source = new EventSource(`/api/market/stream?symbol=${encodeURIComponent(symbol)}`);
      source.addEventListener("status", (event) => {
        const data = readEvent(event);
        if (!data || data.state !== "subscribed") return;
        const id = typeof data.securityId === "string" ? data.securityId : "";
        const segment = typeof data.segment === "string" ? segmentLabel(data.segment) : "";
        setDetail([id ? `Security ${id}` : "", segment].filter(Boolean).join(" · "));
      });
      source.addEventListener("tick", (event) => {
        const data = readEvent(event);
        const price = Number(data?.price);
        const time = Number(data?.time);
        if (!data || !Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || time < 1_000_000_000) return;
        const dayVolume = data.dayVolume == null ? null : Number(data.dayVolume);
        let volumeDelta = 0;
        if (dayVolume != null && Number.isFinite(dayVolume)) {
          const next = intervalVolume(baseline, dayVolume);
          baseline = next.baseline;
          volumeDelta = next.delta;
        }
        setState("live");
        setUpdatedAt(time);
        onTickRef.current({ price, time, volumeDelta, dayVolume });
      });
      source.addEventListener("problem", (event) => {
        const data = readEvent(event);
        setDetail(typeof data?.message === "string" ? data.message : "The market feed disconnected.");
        setState("disconnected");
        if (data?.retry === false) {
          stop = true;
          source?.close();
        }
      });
      source.onerror = () => {
        source?.close();
        if (stop) return;
        attempt += 1;
        const wait = Math.min(15000, 1000 * attempt);
        setState("reconnecting");
        timer = window.setTimeout(open, wait);
      };
    };
    open();
    return () => {
      stop = true;
      source?.close();
      window.clearTimeout(timer);
    };
  }, [symbol, enabled]);

  const age = updatedAt == null ? null : now / 1000 - updatedAt;
  const status: FeedState = state === "live" && age != null && age > 20 ? "delayed" : state;
  return { status, detail, updatedAt };
}

function readEvent(event: Event) {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}
