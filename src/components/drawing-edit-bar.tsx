"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Copy, Eye, EyeOff, GripVertical, Layers, Lock, MoreHorizontal, Save, Settings2, SquareStack, Trash2, Unlock } from "lucide-react";
import { DRAW_PALETTE, LINE_WIDTHS, hexAlpha, isHexColor, loadTemplates, type Drawing, type DrawingTemplate, type LineDash } from "@/components/drawing-model";
import { saveDrawingTemplate } from "@/components/drawing-editor";
import { cx } from "@/components/ui";

type Popover = "line" | "fill" | "text" | "width" | "style" | "more" | null;
export type EditAction = "duplicate" | "forward" | "backward" | "hide";

const TEXT_KINDS = new Set<Drawing["kind"]>(["text", "note", "price", "callout", "marker"]);
const FILL_KINDS = new Set<Drawing["kind"]>(["rect", "ellipse", "circle"]);
const DASHES: Array<{ id: LineDash; label: string; pattern?: string }> = [
  { id: "solid", label: "Solid" },
  { id: "dashed", label: "Dashed", pattern: "6 4" },
  { id: "dotted", label: "Dotted", pattern: "1.5 3" },
];

export function DrawingEditBar({
  drawing,
  locked,
  globalLock,
  at,
  flip,
  onPatch,
  onDelete,
  onToggleLock,
  onSettings,
  onAction,
}: {
  drawing: Drawing;
  locked: boolean;
  globalLock: boolean;
  at: { x: number; y: number };
  flip: boolean;
  onPatch: (patch: Partial<Drawing>) => void;
  onDelete: () => void;
  onToggleLock: () => void;
  onSettings: () => void;
  onAction: (action: EditAction) => void;
}) {
  const [open, setOpen] = useState<Popover>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [templates, setTemplates] = useState<DrawingTemplate[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const textKind = TEXT_KINDS.has(drawing.kind);
  const fillKind = FILL_KINDS.has(drawing.kind);
  const textColor = drawing.textStyle?.color ?? drawing.color;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && barRef.current?.contains(target)) return;
      setOpen(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  function toggle(next: Exclude<Popover, null>) {
    if (next === "more") setTemplates(loadTemplates().filter((template) => template.kind === drawing.kind));
    setOpen((current) => (current === next ? null : next));
  }

  function onGripDown(event: ReactPointerEvent<HTMLButtonElement>) {
    drag.current = { px: event.clientX, py: event.clientY, x: offset.x, y: offset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onGripMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const origin = drag.current;
    const bar = barRef.current;
    const host = bar?.offsetParent as HTMLElement | null;
    if (!origin || !bar || !host) return;
    const half = bar.offsetWidth / 2;
    const x = Math.min(host.clientWidth - half - 4 - at.x, Math.max(half + 4 - at.x, origin.x + event.clientX - origin.px));
    const y = Math.min(host.clientHeight - bar.offsetHeight - 4 - at.y, Math.max(4 - at.y, origin.y + event.clientY - origin.py));
    setOffset({ x, y });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(null);
    }
  }

  function applyTemplate(template: DrawingTemplate) {
    onPatch({
      color: template.color,
      fill: template.fill,
      fillOpacity: template.fillOpacity,
      width: template.width,
      dash: template.dash,
      borderVisible: template.borderVisible,
      fillVisible: template.fillVisible,
      ...(template.center && drawing.kind === "rect" ? { center: template.center } : {}),
    });
    setOpen(null);
  }

  return (
    <div
      ref={barRef}
      data-drawing-menu
      role="toolbar"
      aria-label="Drawing style"
      className="surface-overlay absolute z-30 flex items-center gap-0.5 rounded-lg p-0.5"
      style={{ left: at.x + offset.x, top: at.y + offset.y, transform: "translateX(-50%)", pointerEvents: "auto" }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <button type="button" aria-label="Move style toolbar" title="Drag to move" className="grid h-8 w-4 cursor-grab touch-none place-items-center text-muted hover:text-text active:cursor-grabbing" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      <Control label={textKind ? "Text color" : "Line color"} expanded={open === "line"} disabled={locked} onClick={() => toggle("line")}>
        <ColorGlyph color={drawing.color} kind={textKind ? "text" : "line"} />
      </Control>
      {fillKind ? (
        <Control label="Fill color" expanded={open === "fill"} disabled={locked} onClick={() => toggle("fill")}>
          <ColorGlyph color={drawing.fillVisible === false ? null : (drawing.fill || drawing.color)} kind="fill" />
        </Control>
      ) : null}
      {fillKind && drawing.text ? (
        <Control label="Text color" expanded={open === "text"} disabled={locked} onClick={() => toggle("text")}>
          <ColorGlyph color={textColor} kind="text" />
        </Control>
      ) : null}
      {!textKind ? (
        <>
          <Control label={`Line width: ${Math.round(drawing.width ?? 1.5)}px`} expanded={open === "width"} disabled={locked} onClick={() => toggle("width")}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="M3 10h14" stroke="currentColor" strokeWidth={Math.min(5, Math.max(1, Math.round(drawing.width ?? 1.5)))} /></svg>
          </Control>
          <Control label={`Line style: ${drawing.dash ?? "solid"}`} expanded={open === "style"} disabled={locked} onClick={() => toggle("style")}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="M2 10h16" stroke="currentColor" strokeWidth={1.5} strokeDasharray={DASHES.find((item) => item.id === (drawing.dash ?? "solid"))?.pattern} /></svg>
          </Control>
        </>
      ) : null}
      <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
      <Control label="Settings" onClick={onSettings}><Settings2 className="h-4 w-4" aria-hidden /></Control>
      <Control label={globalLock ? "All drawings are locked" : drawing.locked ? "Unlock" : "Lock"} active={drawing.locked || globalLock} disabled={globalLock} onClick={onToggleLock}>
        {drawing.locked || globalLock ? <Lock className="h-4 w-4" aria-hidden /> : <Unlock className="h-4 w-4" aria-hidden />}
      </Control>
      <Control label="Delete" danger disabled={locked} onClick={onDelete}><Trash2 className="h-4 w-4" aria-hidden /></Control>
      <Control label="More" expanded={open === "more"} onClick={() => toggle("more")}><MoreHorizontal className="h-4 w-4" aria-hidden /></Control>

      {open === "line" ? (
        <Pop flip={flip}>
          <ColorPanel
            value={drawing.color}
            opacity={textKind ? undefined : drawing.borderOpacity ?? 1}
            onColor={(color) => onPatch({ color })}
            onOpacity={(borderOpacity) => onPatch({ borderOpacity })}
          />
        </Pop>
      ) : null}
      {open === "fill" ? (
        <Pop flip={flip}>
          <ColorPanel
            value={drawing.fill || drawing.color}
            opacity={drawing.fillOpacity ?? 0.13}
            none={drawing.fillVisible === false}
            onNone={(hidden) => onPatch({ fillVisible: !hidden })}
            onColor={(fill) => onPatch({ fill, fillVisible: true })}
            onOpacity={(fillOpacity) => onPatch({ fillOpacity })}
          />
        </Pop>
      ) : null}
      {open === "text" ? (
        <Pop flip={flip}>
          <ColorPanel value={textColor} onColor={(color) => onPatch({ textStyle: { ...(drawing.textStyle ?? { size: 12, bold: false, italic: false, align: "center", valign: "middle", visible: true, color }), color } })} />
        </Pop>
      ) : null}
      {open === "width" ? (
        <Pop flip={flip} menu>
          {LINE_WIDTHS.map((width) => (
            <MenuChoice key={width} checked={Math.round(drawing.width ?? 1.5) === width} label={`${width}px`} onClick={() => { onPatch({ width }); setOpen(null); }}>
              <svg width="56" height="14" viewBox="0 0 56 14" aria-hidden><path d="M2 7h52" stroke="currentColor" strokeWidth={width} /></svg>
            </MenuChoice>
          ))}
        </Pop>
      ) : null}
      {open === "style" ? (
        <Pop flip={flip} menu>
          {DASHES.map((item) => (
            <MenuChoice key={item.id} checked={(drawing.dash ?? "solid") === item.id} label={item.label} onClick={() => { onPatch({ dash: item.id }); setOpen(null); }}>
              <svg width="56" height="14" viewBox="0 0 56 14" aria-hidden><path d="M2 7h52" stroke="currentColor" strokeWidth={1.5} strokeDasharray={item.pattern} /></svg>
            </MenuChoice>
          ))}
        </Pop>
      ) : null}
      {open === "more" ? (
        <Pop flip={flip} menu align="right">
          <MenuItem icon={<Copy className="h-4 w-4" aria-hidden />} label="Clone" onClick={() => { onAction("duplicate"); setOpen(null); }} />
          <MenuItem icon={<Layers className="h-4 w-4" aria-hidden />} label="Bring forward" onClick={() => { onAction("forward"); setOpen(null); }} />
          <MenuItem icon={<SquareStack className="h-4 w-4" aria-hidden />} label="Send backward" onClick={() => { onAction("backward"); setOpen(null); }} />
          <MenuItem icon={drawing.hidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />} label={drawing.hidden ? "Show" : "Hide"} onClick={() => { onAction("hide"); setOpen(null); }} />
          <span aria-hidden className="my-1 block h-px bg-border" />
          <MenuItem icon={<Save className="h-4 w-4" aria-hidden />} label="Save style as default" onClick={() => { saveDrawingTemplate(drawing); setOpen(null); }} />
          {templates.length ? <p className="px-2.5 pb-1 pt-2 text-micro font-semibold uppercase tracking-wide text-muted">Apply template</p> : null}
          {templates.map((template) => (
            <MenuItem key={template.id} icon={<span className="h-3.5 w-3.5 rounded-full border border-border" style={{ background: template.color }} />} label={template.preferred ? `${template.name} (default)` : template.name} disabled={locked} onClick={() => applyTemplate(template)} />
          ))}
        </Pop>
      ) : null}
    </div>
  );
}

function Control({ label, expanded, active, danger, disabled, onClick, children }: { label: string; expanded?: boolean; active?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-pressed={active}
      disabled={disabled}
      className={cx(
        "grid h-8 w-8 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-40",
        expanded ? "bg-hover text-text" : active ? "text-primary hover:bg-hover" : danger ? "text-loss hover:bg-loss-soft" : "text-text-2 hover:bg-hover hover:text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ColorGlyph({ color, kind }: { color: string | null; kind: "line" | "fill" | "text" }) {
  return (
    <span className="relative grid h-5 w-5 place-items-center" aria-hidden>
      {kind === "text" ? <span className="text-[13px] font-semibold leading-none">T</span> : kind === "fill" ? <span className="h-3.5 w-3.5 rounded-[3px] border border-border-strong" style={{ background: color ?? "transparent" }} /> : <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 13 13 3" stroke="currentColor" strokeWidth={1.5} /></svg>}
      {kind !== "fill" ? <span className="absolute inset-x-0.5 -bottom-0.5 h-[3px] rounded-full" style={{ background: color ?? "transparent" }} /> : null}
    </span>
  );
}

function Pop({ flip, menu, align = "left", children }: { flip: boolean; menu?: boolean; align?: "left" | "right"; children: ReactNode }) {
  return (
    <div role={menu ? "menu" : "dialog"} aria-label={menu ? "Options" : "Choose color"} className={cx("surface-overlay absolute z-40 rounded-lg p-1.5", flip ? "bottom-full mb-1.5" : "top-full mt-1.5", align === "right" ? "right-0" : "left-0", menu ? "min-w-44" : "w-[232px]")}>
      {children}
    </div>
  );
}

function MenuChoice({ checked, label, onClick, children }: { checked: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} aria-label={label} className={cx("flex h-8 w-full items-center gap-3 rounded-md px-2 text-dense focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]", checked ? "bg-primary-soft text-primary" : "text-text hover:bg-hover")} onClick={onClick}>
      {children}
      <span className="text-data text-muted">{label}</span>
    </button>
  );
}

function MenuItem({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-dense text-text hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)] disabled:opacity-40" onClick={onClick}>
      <span className="grid w-4 place-items-center text-text-2">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function ColorPanel({ value, opacity, none, onNone, onColor, onOpacity }: { value: string; opacity?: number; none?: boolean; onNone?: (hidden: boolean) => void; onColor: (color: string) => void; onOpacity?: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  const current = value.toUpperCase();
  const valid = isHexColor(draft);
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-6 gap-1">
        {DRAW_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={`Color ${color}`}
            aria-pressed={!none && current === color}
            className={cx("h-7 w-full rounded-[5px] border border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)]", !none && current === color && "ring-2 ring-primary ring-offset-1 ring-offset-[var(--overlay)]")}
            style={{ background: color }}
            onClick={() => { setDraft(color); onColor(color); }}
          />
        ))}
      </div>
      {onNone ? (
        <label className="flex items-center gap-2 text-data text-text-2">
          <input type="checkbox" checked={Boolean(none)} onChange={(event) => onNone(event.target.checked)} />
          No fill
        </label>
      ) : null}
      {opacity != null && onOpacity ? (
        <label className="grid gap-1 text-data text-text-2">
          <span className="flex justify-between"><span>Opacity</span><span className="tnum">{Math.round(opacity * 100)}%</span></span>
          <input type="range" min={0} max={100} value={Math.round(opacity * 100)} aria-label="Opacity" onChange={(event) => onOpacity(Number(event.target.value) / 100)} style={{ accentColor: hexAlpha(value, 1) }} />
        </label>
      ) : null}
      <div className="flex items-center gap-1.5">
        <input type="color" aria-label="Custom color" className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5" value={isHexColor(value) ? value : "#000000"} onChange={(event) => { const next = event.target.value.toUpperCase(); setDraft(next); if (isHexColor(next)) onColor(next); }} />
        <input
          aria-label="Hex color"
          aria-invalid={!valid}
          className="h-8 min-w-0 flex-1 font-mono text-data uppercase"
          value={draft}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value.trim())}
          onKeyDown={(event) => { if (event.key === "Enter" && valid) onColor(draft.toUpperCase()); }}
          onBlur={() => { if (valid && draft.toUpperCase() !== current) onColor(draft.toUpperCase()); }}
        />
      </div>
    </div>
  );
}
