"use client";

import { useEffect, useState } from "react";
import { useLatest } from "@/components/use-hydrated";
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

type StreamState = { key: string; state: Exclude<FeedState, "delayed">; detail: string; updatedAt: number | null };

export function useMarketStream(symbol: string, enabled: boolean, onTick: (tick: FeedTick) => void) {
  // State belongs to one stream (one symbol). A new symbol starts as "connecting"; disabled reads "historical".
  const streamKey = enabled && symbol ? symbol : null;
  const [stream, setStream] = useState<StreamState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onTickRef = useLatest(onTick);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!streamKey) return;
    const key = streamKey;
    const update = (patch: Partial<Omit<StreamState, "key">>) =>
      setStream((current) => ({ ...(current?.key === key ? current : { key, state: "connecting", detail: "", updatedAt: null }), ...patch, key }));
    let source: EventSource | null = null;
    let timer = 0;
    let stop = false;
    let attempt = 0;
    let baseline: number | null = null;
    const open = () => {
      if (stop) return;
      source = new EventSource(`/api/market/stream?symbol=${encodeURIComponent(key)}`);
      source.addEventListener("status", (event) => {
        const data = readEvent(event);
        if (!data || data.state !== "subscribed") return;
        const id = typeof data.securityId === "string" ? data.securityId : "";
        const segment = typeof data.segment === "string" ? segmentLabel(data.segment) : "";
        update({ detail: [id ? `Security ${id}` : "", segment].filter(Boolean).join(" · ") });
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
        update({ state: "live", updatedAt: time });
        onTickRef.current({ price, time, volumeDelta, dayVolume });
      });
      source.addEventListener("problem", (event) => {
        const data = readEvent(event);
        update({ detail: typeof data?.message === "string" ? data.message : "The market feed disconnected.", state: "disconnected" });
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
        update({ state: "reconnecting" });
        timer = window.setTimeout(open, wait);
      };
    };
    open();
    return () => {
      stop = true;
      source?.close();
      window.clearTimeout(timer);
    };
  }, [streamKey, onTickRef]);

  const current = !streamKey ? null : stream?.key === streamKey ? stream : { key: streamKey, state: "connecting" as const, detail: "", updatedAt: null };
  const state = current?.state ?? "historical";
  const detail = current?.detail ?? "";
  const updatedAt = current?.updatedAt ?? null;
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
