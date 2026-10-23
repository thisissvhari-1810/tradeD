"use client";

import { X } from "lucide-react";
import { ChartIcon } from "@/components/chart-icons";
import type { DrawTool } from "@/components/drawing-model";
import { toolEntry } from "@/components/drawing-tools";
import { useMobilePrefs } from "@/components/mobile-prefs";
import { cx } from "@/components/ui";

/**
 * Phones and tablets: the controls over the bottom of the chart. Draw opens a quick toolbar with the
 * tools chosen in Mobile & compact mode (More opens every tool).
 */
export function MobileChartActions({ tool, onTool, quickOpen, onQuick, onMore }: {
  tool: DrawTool;
  onTool: (tool: DrawTool) => void;
  quickOpen: boolean;
  onQuick: (open: boolean) => void;
  onMore: () => void;
}) {
  const prefs = useMobilePrefs();
  const drawing = tool !== "cursor";
  const current = drawing ? toolEntry(tool) : null;

  if (quickOpen) {
    const tools = prefs.quickTools.map((key) => toolEntry(key)).filter((item) => item != null);
    const cell = (active: boolean) => cx("flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-1.5 text-[0.625rem] font-medium", prefs.toolLabels ? "h-12 min-w-11" : "h-11 w-[2.625rem]", active ? "bg-primary-soft text-primary" : "text-text-2 active:bg-hover");
    return (
      <div className="absolute inset-x-2 bottom-9 z-20 lg:hidden">
        <div className="surface-overlay flex items-center gap-0.5 rounded-card p-1 shadow-e3" role="toolbar" aria-label="Quick drawing tools">
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <button type="button" className={cell(!drawing)} aria-pressed={!drawing} aria-label="Cursor" onClick={() => onTool("cursor")}>
              <ChartIcon name="crosshair" />
              {prefs.toolLabels ? <span>Cursor</span> : null}
            </button>
            {tools.map((item) => (
              <button key={item.key} type="button" className={cell(tool === item.tool)} aria-pressed={tool === item.tool} aria-label={item.label} title={item.label} onClick={() => onTool(tool === item.tool ? "cursor" : item.tool)}>
                <ChartIcon name={item.icon} />
                {prefs.toolLabels ? <span className="max-w-14 truncate">{item.label.replace(/ line$/i, "")}</span> : null}
              </button>
            ))}
          </div>
          <span className="mx-0.5 h-7 w-px shrink-0 bg-border" aria-hidden />
          <button type="button" className={cx(cell(false), "w-auto px-2 text-data font-semibold")} onClick={onMore}>More</button>
          <button type="button" className={cell(false)} aria-label="Close drawing tools" onClick={() => { onQuick(false); onTool("cursor"); }}><X className="h-[1.125rem] w-[1.125rem]" aria-hidden /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-9 z-20 flex items-center gap-2 lg:hidden">
      <button type="button" className={cx("pointer-events-auto inline-flex h-11 items-center gap-1.5 rounded-pill px-3.5 text-data font-semibold shadow-e3", drawing ? "bg-primary text-on-primary" : "surface-overlay text-text")} aria-expanded={false} onClick={() => onQuick(true)}>
        <ChartIcon name={current?.icon ?? "trend"} />
        {current?.label ?? "Draw"}
      </button>
    </div>
  );
}
