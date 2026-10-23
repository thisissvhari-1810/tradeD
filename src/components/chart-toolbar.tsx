"use client";

import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GripVertical, Star, X } from "lucide-react";
import { ChartIcon, type ChartIconName } from "@/components/chart-icons";
import type { CursorStyle, DrawTool, MagnetMode } from "@/components/drawing-model";
import { moveFavourite, toggleFavourite, updatePrefs, useDrawingPrefs } from "@/components/drawing-prefs";
import { SINGLE_TOOLS, TOOL_GROUPS, isActiveEntry, toolEntry, type ToolEntry, type ToolGroup } from "@/components/drawing-tools";
import { cx } from "@/components/ui";

type MenuId = string;
type MenuState = { id: MenuId; top: number; left: number; sheet: boolean; trigger: HTMLElement | null };
export type VisibilityAction = "drawings" | "indicators" | "all" | "show";
export type RemoveScope = "drawings" | "indicators" | "all";

const MAGNET_LABEL: Record<MagnetMode, string> = { off: "Magnet off", weak: "Weak magnet", strong: "Strong magnet" };
const MAGNET_ICON: Record<MagnetMode, ChartIconName> = { off: "magnet", weak: "magnetWeak", strong: "magnetStrong" };

export function ChartToolbar({
  tool,
  onTool,
  lockAll,
  onLockAll,
  drawingsHidden,
  indicatorsHidden,
  onVisibility,
  onRemove,
  objectsOpen,
  onObjects,
}: {
  tool: DrawTool;
  onTool: (tool: DrawTool) => void;
  lockAll: boolean;
  onLockAll: () => void;
  drawingsHidden: boolean;
  indicatorsHidden: boolean;
  onVisibility: (action: VisibilityAction) => void;
  onRemove: (scope: RemoveScope) => void;
  objectsOpen: boolean;
  onObjects: () => void;
}) {
  const prefs = useDrawingPrefs();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (node && !menu.sheet) {
      const overflow = node.getBoundingClientRect().bottom - (window.innerHeight - 8);
      if (overflow > 0) node.style.top = `${Math.max(8, menu.top - overflow)}px`;
    }
    const first = node?.querySelector<HTMLElement>("[role='menuitemradio'][aria-checked='true']") ?? node?.querySelector<HTMLElement>("[data-menu-item]");
    first?.focus();
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || menu.trigger?.contains(target))) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  function openMenu(id: MenuId, trigger: HTMLElement) {
    if (menu?.id === id) {
      setMenu(null);
      return;
    }
    const sheet = window.matchMedia("(max-width: 639px)").matches;
    const rect = trigger.getBoundingClientRect();
    const vertical = window.matchMedia("(min-width: 1024px)").matches;
    const top = vertical ? rect.top : rect.bottom + 6;
    const left = vertical ? rect.right + 8 : Math.max(8, Math.min(rect.left, window.innerWidth - 268));
    setMenu({ id, top, left, sheet, trigger });
  }

  function closeMenu(focusTrigger = false) {
    const trigger = menu?.trigger;
    setMenu(null);
    if (focusTrigger) trigger?.focus();
  }

  function choose(group: string | null, item: ToolEntry) {
    updatePrefs((current) => ({
      ...(item.cursor ? { cursor: item.cursor } : {}),
      ...(group ? { last: { ...current.last, [group]: item.key } } : {}),
    }));
    onTool(item.tool);
    setMenu(null);
  }

  function groupEntry(group: ToolGroup) {
    return group.entries.find((item) => isActiveEntry(item, tool, prefs.cursor))
      ?? group.entries.find((item) => item.key === prefs.last[group.id])
      ?? group.entries[0];
  }

  const magnetNext: MagnetMode = prefs.magnet === "off" ? "strong" : "off";
  const menuGroup = TOOL_GROUPS.find((group) => group.id === menu?.id) ?? null;

  return (
    <nav ref={rootRef} className="no-scrollbar hidden h-12 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-panel px-1 lg:flex lg:h-auto lg:w-12 lg:flex-col lg:overflow-y-auto lg:overflow-x-visible lg:border-b-0 lg:border-r lg:px-0 lg:py-1.5" aria-label="Drawing tools">
      {TOOL_GROUPS.map((group) => {
        const current = groupEntry(group);
        const active = group.entries.some((item) => isActiveEntry(item, tool, prefs.cursor));
        return (
          <RailSplit
            key={group.id}
            label={current.label}
            groupLabel={group.label}
            icon={current.icon}
            active={active}
            expanded={menu?.id === group.id}
            onMain={() => choose(group.id, current)}
            onMenu={(trigger) => openMenu(group.id, trigger)}
          />
        );
      })}
      <RailDivider />
      {SINGLE_TOOLS.map((item) => (
        <RailSplit key={item.key} label={item.hint ? `${item.label}. ${item.hint}` : item.label} icon={item.icon} active={tool === item.tool} onMain={() => onTool(tool === item.tool ? "cursor" : item.tool)} />
      ))}
      <RailSplit
        label={prefs.magnet === "off" ? "Magnet off. Click to snap to candle prices." : `${MAGNET_LABEL[prefs.magnet]} on`}
        groupLabel="Magnet modes"
        icon={MAGNET_ICON[prefs.magnet]}
        active={prefs.magnet !== "off"}
        expanded={menu?.id === "magnet"}
        onMain={() => updatePrefs({ magnet: magnetNext })}
        onMenu={(trigger) => openMenu("magnet", trigger)}
      />
      <RailSplit label={prefs.stay ? "Stay in drawing mode is on" : "Stay in drawing mode is off"} icon="stay" active={prefs.stay} onMain={() => updatePrefs({ stay: !prefs.stay })} />
      <RailSplit label={lockAll ? "Unlock all drawings" : "Lock all drawings"} icon={lockAll ? "lock" : "unlock"} active={lockAll} onMain={onLockAll} />
      <RailSplit
        label={drawingsHidden ? "Show drawings" : "Hide drawings"}
        groupLabel="Visibility options"
        icon={drawingsHidden || indicatorsHidden ? "eyeOff" : "eye"}
        active={drawingsHidden || indicatorsHidden}
        expanded={menu?.id === "hide"}
        onMain={() => onVisibility(drawingsHidden ? "show" : "drawings")}
        onMenu={(trigger) => openMenu("hide", trigger)}
      />
      <RailSplit label="Remove objects" icon="trash" expanded={menu?.id === "remove"} menuOnly onMain={() => undefined} onMenu={(trigger) => openMenu("remove", trigger)} />
      <RailDivider />
      <RailSplit label={objectsOpen ? "Hide object tree" : "Object tree"} icon="objects" active={objectsOpen} onMain={onObjects} />
      {menu ? (
        <Flyout menu={menu} menuRef={menuRef} onClose={closeMenu} label={menuGroup?.label ?? (menu.id === "magnet" ? "Magnet modes" : menu.id === "hide" ? "Visibility" : "Remove")}>
          {menuGroup ? <ToolRows group={menuGroup} tool={tool} cursor={prefs.cursor} favourites={prefs.favourites} onChoose={(item) => choose(menuGroup.id, item)} /> : null}
          {menu.id === "magnet" ? (["weak", "strong", "off"] as const).map((mode) => (
            <MenuRow key={mode} icon={MAGNET_ICON[mode]} label={mode === "off" ? "Off" : MAGNET_LABEL[mode]} hint={mode === "weak" ? "Snaps when the pointer is near a price" : mode === "strong" ? "Always snaps to open, high, low or close" : undefined} checked={prefs.magnet === mode} onClick={() => { updatePrefs({ magnet: mode }); closeMenu(); }} />
          )) : null}
          {menu.id === "hide" ? (
            <>
              <MenuRow icon="eyeOff" label="Hide drawings" checked={drawingsHidden && !indicatorsHidden} onClick={() => { onVisibility("drawings"); closeMenu(); }} />
              <MenuRow icon="indicators" label="Hide indicators" checked={indicatorsHidden && !drawingsHidden} onClick={() => { onVisibility("indicators"); closeMenu(); }} />
              <MenuRow icon="eyeOff" label="Hide all" checked={drawingsHidden && indicatorsHidden} onClick={() => { onVisibility("all"); closeMenu(); }} />
              <MenuRow icon="eye" label="Show all" checked={!drawingsHidden && !indicatorsHidden} onClick={() => { onVisibility("show"); closeMenu(); }} />
            </>
          ) : null}
          {menu.id === "remove" ? (
            <>
              <MenuRow icon="trash" label="Remove drawings" onClick={() => { closeMenu(); onRemove("drawings"); }} />
              <MenuRow icon="indicators" label="Remove indicators" onClick={() => { closeMenu(); onRemove("indicators"); }} />
              <MenuRow icon="trash" label="Remove drawings and indicators" danger onClick={() => { closeMenu(); onRemove("all"); }} />
            </>
          ) : null}
        </Flyout>
      ) : null}
    </nav>
  );
}

function RailDivider() {
  return <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-border lg:mx-0 lg:my-1 lg:h-px lg:w-6" />;
}

function RailSplit({
  label,
  groupLabel,
  icon,
  active,
  expanded,
  menuOnly,
  onMain,
  onMenu,
}: {
  label: string;
  groupLabel?: string;
  icon: ChartIconName;
  active?: boolean;
  expanded?: boolean;
  menuOnly?: boolean;
  onMain: () => void;
  onMenu?: (trigger: HTMLElement) => void;
}) {
  const timer = useRef<number | null>(null);
  const pressed = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  function clearPress() {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!onMenu || event.pointerType !== "touch") return;
    pressed.current = false;
    const target = wrapRef.current;
    timer.current = window.setTimeout(() => {
      pressed.current = true;
      if (target) onMenu(target);
    }, 450);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!onMenu || !wrapRef.current) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      onMenu(wrapRef.current);
    }
  }

  return (
    <div ref={wrapRef} className="group/rail relative shrink-0">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={menuOnly ? undefined : Boolean(active)}
        aria-haspopup={menuOnly ? "menu" : undefined}
        aria-expanded={menuOnly ? Boolean(expanded) : undefined}
        className={cx(
          "relative grid h-9 w-10 place-items-center rounded-md [@media(max-height:820px)]:h-8 transition-colors duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]",
          active ? "bg-primary-soft text-primary" : expanded ? "bg-hover text-text" : "text-text-2 hover:bg-hover hover:text-text",
        )}
        onPointerDown={onPointerDown}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onContextMenu={(event) => { if (onMenu && pressed.current) event.preventDefault(); }}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          if (pressed.current) { pressed.current = false; return; }
          if (menuOnly && onMenu && wrapRef.current) onMenu(wrapRef.current);
          else onMain();
          event.currentTarget.blur();
        }}
      >
        {active ? <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 hidden w-0.5 rounded-full bg-primary lg:block" /> : null}
        <ChartIcon name={icon} />
      </button>
      {onMenu && !menuOnly ? (
        <button
          type="button"
          aria-label={`More ${groupLabel ?? label}`}
          title={groupLabel ?? label}
          aria-haspopup="menu"
          aria-expanded={Boolean(expanded)}
          className="absolute bottom-0 right-0 grid h-4 w-4 place-items-end rounded-sm p-[0.1875rem] text-muted opacity-70 hover:text-text hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] group-hover/rail:opacity-100"
          onClick={() => wrapRef.current && onMenu(wrapRef.current)}
        >
          <span aria-hidden className="h-0 w-0 border-b-[0.3125rem] border-l-[0.3125rem] border-b-current border-l-transparent" />
        </button>
      ) : null}
    </div>
  );
}

function Flyout({ menu, menuRef, label, onClose, children }: { menu: MenuState; menuRef: { current: HTMLDivElement | null }; label: string; onClose: (focusTrigger?: boolean) => void; children: ReactNode }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const panel = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className={cx(
        "surface-overlay z-50 overflow-y-auto p-1",
        menu.sheet ? "fixed inset-x-0 bottom-0 max-h-[65vh] rounded-t-xl pb-[calc(env(safe-area-inset-bottom)+0.5rem)]" : "fixed max-h-[70vh] w-64 rounded-lg",
      )}
      style={menu.sheet ? undefined : { top: menu.top, left: menu.left }}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {menu.sheet ? <p className="px-3 pb-1 pt-2 text-micro font-semibold uppercase tracking-wide text-muted">{label}</p> : null}
      {children}
    </div>
  );
  if (!menu.sheet) return panel;
  return (
    <>
      <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 bg-black/30" onClick={() => onClose(true)} />
      {panel}
    </>
  );
}

function ToolRows({ group, tool, cursor, favourites, onChoose }: { group: ToolGroup; tool: DrawTool; cursor: CursorStyle; favourites: string[]; onChoose: (item: ToolEntry) => void }) {
  let last = "";
  return group.entries.map((item) => {
    const heading = item.section && item.section !== last ? item.section : null;
    if (item.section) last = item.section;
    const favourite = favourites.includes(item.key);
    return (
      <Fragment key={item.key}>
        {heading ? <p role="presentation" className="px-2.5 pb-1 pt-2.5 text-micro font-semibold uppercase tracking-wide text-muted">{heading}</p> : null}
        <div className="group/row flex items-center rounded-md hover:bg-hover">
          <MenuRow icon={item.icon} label={item.label} hint={item.hint} checked={isActiveEntry(item, tool, cursor)} onClick={() => onChoose(item)} bare />
          <button
            type="button"
            data-menu-item
            role="menuitemcheckbox"
            aria-label={`${item.label} in favourites`}
            title={favourite ? "Remove from favourites" : "Add to favourites"}
            aria-checked={favourite}
            className={cx("mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]", favourite ? "text-warning" : "text-muted opacity-0 hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 max-sm:opacity-100")}
            onClick={() => toggleFavourite(item.key)}
          >
            <Star className={cx("h-3.5 w-3.5", favourite && "fill-current")} aria-hidden />
          </button>
        </div>
      </Fragment>
    );
  });
}

function MenuRow({ icon, label, hint, checked, danger, bare, onClick }: { icon: ChartIconName; label: string; hint?: string; checked?: boolean; danger?: boolean; bare?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-menu-item
      role={checked == null ? "menuitem" : "menuitemradio"}
      aria-checked={checked == null ? undefined : checked}
      title={hint}
      className={cx(
        "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 pl-1 pr-2 text-left text-dense focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]",
        !bare && "w-full hover:bg-hover",
        checked ? "font-medium text-primary" : danger ? "text-loss" : "text-text",
      )}
      onClick={onClick}
    >
      <ChartIcon name={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /> : null}
    </button>
  );
}

export function FavouritesBar({ tool, onTool }: { tool: DrawTool; onTool: (tool: DrawTool) => void }) {
  const prefs = useDrawingPrefs();
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const items = prefs.favourites.flatMap((key) => {
    const item = toolEntry(key);
    return item ? [item] : [];
  });
  if (!items.length) return null;
  const at = drag ?? prefs.favBar;

  function onGripDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    start.current = { px: event.clientX, py: event.clientY, x: at.x, y: at.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onGripMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const origin = start.current;
    const bar = barRef.current;
    const parent = bar?.parentElement;
    if (!origin || !bar || !parent) return;
    const maxX = Math.max(0, parent.clientWidth - bar.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - bar.offsetHeight);
    setDrag({
      x: Math.min(maxX, Math.max(0, origin.x + event.clientX - origin.px)),
      y: Math.min(maxY, Math.max(0, origin.y + event.clientY - origin.py)),
    });
  }

  function onGripUp() {
    if (drag) updatePrefs({ favBar: drag });
    start.current = null;
    setDrag(null);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>, before: string) {
    event.preventDefault();
    const key = event.dataTransfer.getData("text/x-td-tool");
    if (key && key !== before) moveFavourite(key, before);
  }

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Favourite drawing tools"
      className="surface-overlay absolute z-20 flex max-w-[calc(100%-16px)] items-center gap-0.5 overflow-x-auto rounded-lg p-0.5"
      style={{ left: `clamp(0px, ${at.x}px, calc(100% - 48px))`, top: `clamp(0px, ${at.y}px, calc(100% - 44px))` }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Move favourites bar"
        title="Drag to move"
        className="grid h-9 w-5 shrink-0 cursor-grab touch-none place-items-center rounded text-muted hover:text-text active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      {items.map((item) => {
        const active = isActiveEntry(item, tool, prefs.cursor);
        return (
          <button
            key={item.key}
            type="button"
            draggable
            title={`${item.label}. Drag to reorder`}
            aria-label={item.label}
            aria-pressed={active}
            className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]", active ? "bg-primary-soft text-primary" : "text-text-2 hover:bg-hover hover:text-text")}
            onDragStart={(event) => { event.dataTransfer.setData("text/x-td-tool", item.key); event.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, item.key)}
            onClick={() => {
              if (item.cursor) updatePrefs({ cursor: item.cursor });
              onTool(item.tool);
            }}
          >
            <ChartIcon name={item.icon} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Phones and tablets: the drawing tools as a bottom sheet instead of the narrow toolbar row. Tools are
 * grouped by category with large touch targets; the actions tab holds undo / redo, magnet, lock, hide,
 * remove and the object tree. Picking a tool closes the sheet so the next touch on the chart draws.
 */
export function MobileDrawingSheet({
  open,
  onClose,
  tool,
  onTool,
  lockAll,
  onLockAll,
  drawingsHidden,
  indicatorsHidden,
  onVisibility,
  onRemove,
  objectsOpen,
  onObjects,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  open: boolean;
  onClose: () => void;
  tool: DrawTool;
  onTool: (tool: DrawTool) => void;
  lockAll: boolean;
  onLockAll: () => void;
  drawingsHidden: boolean;
  indicatorsHidden: boolean;
  onVisibility: (action: VisibilityAction) => void;
  onRemove: (scope: RemoveScope) => void;
  objectsOpen: boolean;
  onObjects: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const prefs = useDrawingPrefs();
  const groups = TOOL_GROUPS.filter((group) => group.id !== "cursors");
  const activeGroup = groups.find((group) => group.entries.some((item) => isActiveEntry(item, tool, prefs.cursor)));
  const [tab, setTab] = useState<string>(activeGroup?.id ?? groups[0]?.id ?? "actions");
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const group = groups.find((item) => item.id === tab);
  const pick = (item: ToolEntry) => {
    updatePrefs((current) => ({ ...(item.cursor ? { cursor: item.cursor } : {}), last: { ...current.last, [group?.id ?? ""]: item.key } }));
    onTool(item.tool);
    onClose();
  };
  const action = (label: string, icon: ChartIconName, onClick: () => void, options: { active?: boolean; disabled?: boolean; danger?: boolean; keep?: boolean } = {}) => (
    <button
      key={label}
      type="button"
      disabled={options.disabled}
      aria-pressed={options.active}
      className={cx("flex min-h-[4.25rem] flex-col items-center justify-center gap-1 rounded-md border px-1 py-2 text-center text-micro font-medium disabled:opacity-40", options.active ? "border-primary/40 bg-primary-soft text-primary" : options.danger ? "border-border-soft text-loss" : "border-border-soft text-text-2 active:bg-hover")}
      onClick={() => { onClick(); if (!options.keep) onClose(); }}
    >
      <ChartIcon name={icon} />
      <span className="leading-tight">{label}</span>
    </button>
  );
  return (
    <div className="fixed inset-0 z-[75] lg:hidden">
      <button type="button" className="anim-fade absolute inset-0 bg-[var(--scrim)]" aria-label="Close drawing tools" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Drawing tools" className="surface-modal anim-sheet absolute inset-x-0 bottom-0 flex max-h-[min(78dvh,36rem)] flex-col rounded-t-sheet pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" aria-hidden />
        <div className="flex items-center justify-between px-4 pb-1 pt-2">
          <h2 className="text-title font-semibold">Drawing tools</h2>
          <button type="button" className="grid h-10 w-10 place-items-center rounded-input text-muted active:bg-hover" aria-label="Close" onClick={onClose}><X className="h-5 w-5" aria-hidden /></button>
        </div>
        <div className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-2" role="tablist" aria-label="Tool categories">
          {[...groups.map((item) => ({ id: item.id, label: item.label })), { id: "actions", label: "Actions" }].map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={cx("h-9 shrink-0 rounded-pill px-3.5 text-data font-medium", tab === item.id ? "bg-primary text-on-primary" : "bg-sunken text-text-2")} onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2">
          {group ? (
            <div className="grid grid-cols-3 gap-2 min-[400px]:grid-cols-4">
              {group.entries.map((item) => {
                const current = isActiveEntry(item, tool, prefs.cursor);
                return (
                  <button key={item.key} type="button" aria-pressed={current} title={item.hint} className={cx("flex min-h-[4.25rem] flex-col items-center justify-center gap-1 rounded-md border px-1 py-2 text-center text-micro font-medium", current ? "border-primary/40 bg-primary-soft text-primary" : "border-border-soft text-text-2 active:bg-hover")} onClick={() => pick(item)}>
                    <ChartIcon name={item.icon} />
                    <span className="leading-tight">{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 min-[400px]:grid-cols-4">
              {action("Undo", "undo", onUndo, { disabled: !canUndo, keep: true })}
              {action("Redo", "redo", onRedo, { disabled: !canRedo, keep: true })}
              {action(prefs.magnet === "off" ? "Magnet off" : MAGNET_LABEL[prefs.magnet], MAGNET_ICON[prefs.magnet], () => updatePrefs({ magnet: prefs.magnet === "off" ? "strong" : "off" }), { active: prefs.magnet !== "off", keep: true })}
              {action("Stay in drawing", "stay", () => updatePrefs({ stay: !prefs.stay }), { active: prefs.stay, keep: true })}
              {action(lockAll ? "Unlock all" : "Lock all", lockAll ? "lock" : "unlock", onLockAll, { active: lockAll, keep: true })}
              {action(drawingsHidden ? "Show drawings" : "Hide drawings", drawingsHidden ? "eyeOff" : "eye", () => onVisibility(drawingsHidden ? "show" : "drawings"), { active: drawingsHidden, keep: true })}
              {action(indicatorsHidden ? "Show indicators" : "Hide indicators", "indicators", () => onVisibility(indicatorsHidden ? "show" : "indicators"), { active: indicatorsHidden, keep: true })}
              {action(objectsOpen ? "Hide object tree" : "Object tree", "objects", onObjects, { active: objectsOpen })}
              {action("Remove drawings", "trash", () => onRemove("drawings"), { danger: true })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
