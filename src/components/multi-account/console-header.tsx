"use client";

import { FlaskConical, Lock, OctagonX, Play, RefreshCw, ShieldAlert } from "lucide-react";
import { FIELD } from "@/components/multi-account/format";
import { Badge, cx, Tooltip } from "@/components/ui";

export function ConsoleHeader({ mode, onMode, sourceKind, onSourceKind, replayDate, onReplayDate, replayTime, onReplayTime, maxDate, updatedAt, refreshing, onRefresh, halted, showHalt, onHalt }: {
  mode: "DEMO" | "LIVE";
  onMode: (next: "DEMO" | "LIVE") => void;
  sourceKind: "chain" | "replay";
  onSourceKind: (next: "chain" | "replay") => void;
  replayDate: string;
  onReplayDate: (next: string) => void;
  replayTime: string;
  onReplayTime: (next: string) => void;
  maxDate: string;
  updatedAt: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
  halted: boolean;
  showHalt: boolean;
  onHalt: () => void;
}) {
  const live = mode === "LIVE";
  return (
    <header className="sticky top-0 z-20 -mx-3 border-b border-border-soft bg-background/95 px-3 py-2.5 backdrop-blur-md sm:-mx-4 sm:px-4 lg:-mx-5 lg:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-title font-semibold text-text sm:text-section">Multi-Account Trading</h1>
          {live
            ? <span className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-loss px-2 text-micro font-bold uppercase tracking-[0.06em] text-on-signal"><ShieldAlert className="h-3.5 w-3.5" aria-hidden />Live · read-only</span>
            : <Badge tone="demo" dot>Practice · simulated</Badge>}
          {halted && !live ? <Badge tone="loss" dot>Stopped</Badge> : null}
        </div>

        {!live ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Price source">
            <div role="radiogroup" aria-label="Price source" className="inline-flex rounded-input border border-border-soft bg-sunken p-0.5">
              {([["chain", "Live chain"], ["replay", "Replay"]] as const).map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={sourceKind === id} onClick={() => onSourceKind(id)}
                  className={cx("h-7 whitespace-nowrap rounded-sm px-3 text-data font-medium transition-colors", sourceKind === id ? "bg-elevated text-text shadow-e1 ring-1 ring-border" : "text-muted hover:text-text")}>
                  {label}
                </button>
              ))}
            </div>
            {sourceKind === "replay" ? (
              <>
                <input type="date" aria-label="Replay date" className={cx(FIELD, "h-8 w-[138px]")} value={replayDate} max={maxDate} onChange={(event) => onReplayDate(event.target.value)} />
                <input type="time" aria-label="Replay time, IST" className={cx(FIELD, "h-8 w-[104px]")} min="09:16" max="15:30" value={replayTime} onChange={(event) => onReplayTime(event.target.value)} />
                <span className="text-micro text-muted">IST</span>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="hidden items-center gap-1.5 whitespace-nowrap text-micro text-muted md:inline-flex" aria-live="off">
            <span className={cx("h-1.5 w-1.5 rounded-full", refreshing ? "animate-pulse bg-info" : updatedAt ? "bg-profit" : "bg-border")} aria-hidden />
            {refreshing ? "Synchronising" : updatedAt ? `${live ? "Synced" : "Updated"} ${updatedAt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Not synced"} · auto {live ? "60s" : "30s"}
          </span>
          <Tooltip content="Refresh accounts and prices">
            <button type="button" aria-label="Refresh accounts and prices" onClick={onRefresh} className="grid h-8 w-8 place-items-center rounded-input border border-border-soft text-muted transition-colors hover:bg-hover hover:text-text">
              <RefreshCw className={cx("h-4 w-4", refreshing && "animate-spin")} aria-hidden />
            </button>
          </Tooltip>
          <div role="radiogroup" aria-label="Trading mode" className="inline-flex rounded-input border border-border p-0.5">
            <button type="button" role="radio" aria-checked={live} onClick={() => onMode("LIVE")}
              className={cx("inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-data font-semibold transition-colors", live ? "bg-loss-soft text-loss" : "text-muted hover:text-text")}>
              <Lock className="h-3.5 w-3.5" aria-hidden />Live accounts
            </button>
            <button type="button" role="radio" aria-checked={!live} onClick={() => onMode("DEMO")}
              className={cx("inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-data font-semibold transition-colors", !live ? "bg-demo-soft text-demo" : "text-muted hover:text-text")}>
              <FlaskConical className="h-3.5 w-3.5" aria-hidden />Practice
            </button>
          </div>
          {showHalt ? (
            <>
              <span className="mx-1 hidden h-6 w-px bg-border-soft sm:block" aria-hidden />
              {halted
                ? <button type="button" onClick={onHalt} className="inline-flex h-8 items-center gap-1.5 rounded-input border border-border bg-elevated px-3 text-data font-semibold text-text transition-colors hover:bg-hover"><Play className="h-3.5 w-3.5" aria-hidden />Resume orders</button>
                : <button type="button" onClick={onHalt} className="inline-flex h-8 items-center gap-1.5 rounded-input bg-loss px-3 text-data font-semibold text-on-signal shadow-e1 transition hover:brightness-110"><OctagonX className="h-4 w-4" aria-hidden />Emergency stop</button>}
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
