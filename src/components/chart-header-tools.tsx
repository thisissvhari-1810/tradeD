"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { ChartIcon, type ChartIconName } from "@/components/chart-icons";
import type { ChartType } from "@/components/chart-panel";
import { cx } from "@/components/ui";

const CHART_TYPES: Array<{ id: ChartType; label: string; icon: ChartIconName }> = [
  { id: "candle", label: "Candles", icon: "candle" },
  { id: "bar", label: "Bars", icon: "bar" },
  { id: "line", label: "Line", icon: "line" },
  { id: "area", label: "Area", icon: "area" },
];

export function ChartHeaderTools({
  chartType,
  onChartType,
  indicatorsOpen,
  onIndicators,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  volumeVisible,
  onToggleVolume,
  onZoom,
  onReset,
  refreshing,
  onRefresh,
  full,
  onFull,
  children,
}: {
  chartType: ChartType;
  onChartType: (type: ChartType) => void;
  indicatorsOpen: boolean;
  onIndicators: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  volumeVisible: boolean;
  onToggleVolume: () => void;
  onZoom: (direction: 1 | -1) => void;
  onReset: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  full: boolean;
  onFull: () => void;
  children?: ReactNode;
}) {
  const current = CHART_TYPES.find((item) => item.id === chartType) ?? CHART_TYPES[0];
  return (
    <>
      <HeaderDivider />
      <ChartTypeMenu current={current} onChange={onChartType} />
      <button
        type="button"
        aria-pressed={indicatorsOpen}
        title="Indicators"
        className={cx("flex h-8 shrink-0 items-center gap-1 rounded-md pl-1 pr-2 text-data font-medium focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]", indicatorsOpen ? "bg-primary-soft text-primary" : "text-text-2 hover:bg-hover hover:text-text")}
        onClick={onIndicators}
      >
        <ChartIcon name="indicators" />
        <span className="hidden xl:inline">Indicators</span>
      </button>
      <HeaderDivider />
      <HeaderButton label="Undo" icon="undo" disabled={!canUndo} onClick={onUndo} />
      <HeaderButton label="Redo" icon="redo" disabled={!canRedo} onClick={onRedo} />
      {children ? <><HeaderDivider />{children}</> : null}
      <span aria-hidden className="min-w-2 flex-1" />
      <HeaderButton label={volumeVisible ? "Hide volume" : "Show volume"} icon={volumeVisible ? "volume" : "volumeOff"} active={volumeVisible} onClick={onToggleVolume} />
      {/* Wheel, pinch and double-click already zoom and reset; the buttons return on wide screens. */}
      <HeaderButton label="Zoom out" icon="zoomOut" className="hidden 2xl:grid" onClick={() => onZoom(-1)} />
      <HeaderButton label="Zoom in" icon="zoomIn" className="hidden 2xl:grid" onClick={() => onZoom(1)} />
      <HeaderButton label="Reset chart view" icon="reset" className="hidden 2xl:grid" onClick={onReset} />
      <HeaderButton label={refreshing ? "Refreshing chart" : "Refresh chart"} icon="refresh" disabled={refreshing} onClick={onRefresh} />
      <HeaderButton label={full ? "Exit full screen" : "Full screen"} icon={full ? "minimize" : "maximize"} onClick={onFull} />
    </>
  );
}

function HeaderDivider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

function HeaderButton({ label, icon, active, disabled, className, onClick }: { label: string; icon: ChartIconName; active?: boolean; disabled?: boolean; className?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:pointer-events-none disabled:text-disabled", active ? "text-primary hover:bg-hover" : "text-text-2 hover:bg-hover hover:text-text", className)}
      onClick={onClick}
    >
      <ChartIcon name={icon} />
    </button>
  );
}

function ChartTypeMenu({ current, onChange }: { current: (typeof CHART_TYPES)[number]; onChange: (type: ChartType) => void }) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchor) return;
    menuRef.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      setAnchor(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [anchor]);

  function toggle() {
    if (anchor) { setAnchor(null); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 188)) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setAnchor(null);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={`Chart type: ${current.label}`}
        aria-label={`Chart type: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        className={cx("flex h-8 shrink-0 items-center rounded-md pl-0.5 pr-1 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]", anchor ? "bg-hover text-text" : "text-text-2 hover:bg-hover hover:text-text")}
        onClick={toggle}
      >
        <ChartIcon name={current.icon} />
        <ChevronDown className="h-3 w-3" aria-hidden />
      </button>
      {anchor ? (
        <div ref={menuRef} role="menu" aria-label="Chart type" className="surface-overlay fixed z-50 w-44 rounded-lg p-1" style={anchor} onKeyDown={onKeyDown}>
          {CHART_TYPES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === current.id}
              className={cx("flex h-9 w-full items-center gap-2 rounded-md pl-1 pr-2 text-left text-dense focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]", item.id === current.id ? "font-medium text-primary" : "text-text hover:bg-hover")}
              onClick={() => { onChange(item.id); setAnchor(null); triggerRef.current?.focus(); }}
            >
              <ChartIcon name={item.icon} />
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
