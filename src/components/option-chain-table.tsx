"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Star } from "lucide-react";
import { cx } from "@/components/ui";

export type ChainSide = {
  ltp: number | null;
  previousClose?: number | null;
  oi: number | null;
  oiChangePct: number | null;
  volume: number | null;
  iv?: number | null;
  bid?: number | null;
  ask?: number | null;
  securityId?: string | null;
};
export type ChainStrike = { strike: number; ce: ChainSide | null; pe: ChainSide | null };
export type Right = "CE" | "PE";

export type ChainActions = {
  /** Overrides the default rule that a row needs a premium before it can be traded. */
  canTrade?: (right: Right, strike: number, side: ChainSide | null) => boolean;
  canSell: (right: Right, strike: number) => boolean;
  onBuy: (right: Right, strike: number, side: ChainSide) => void;
  onSell: (right: Right, strike: number, side: ChainSide) => void;
  onChart?: (right: Right, strike: number, side: ChainSide) => void;
  isWatched?: (right: Right, strike: number) => boolean;
  onWatch?: (right: Right, strike: number) => void;
};

const ROW = 36;
const OVERSCAN = 8;

/** Calls left, strike centred, puts right. Rows are windowed so a full expiry stays smooth. */
export function OptionChainTable({ strikes, atmStrike, spot, bidAsk, scrollKey, loading, empty, actions, selected, className }: {
  strikes: ChainStrike[];
  atmStrike: number | null;
  spot: number | null;
  bidAsk: boolean;
  scrollKey: string;
  loading: boolean;
  empty: ReactNode;
  actions: ChainActions;
  selected?: string | null;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 480 });
  const centred = useRef("");
  const maxOi = useMemo(() => Math.max(1, ...strikes.flatMap((row) => [row.ce?.oi ?? 0, row.pe?.oi ?? 0])), [strikes]);
  const columns = bidAsk
    ? "minmax(84px,1.3fr) 64px 72px 104px 80px 92px 80px 104px 72px 64px minmax(84px,1.3fr)"
    : "minmax(96px,1.4fr) 72px 80px 84px 96px 84px 80px 72px minmax(96px,1.4fr)";
  const minWidth = bidAsk ? 900 : 700;

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setView({ top: node.scrollTop, height: node.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !strikes.length || centred.current === scrollKey) return;
    const index = atmStrike == null ? -1 : strikes.findIndex((row) => row.strike === atmStrike);
    if (index < 0) return;
    centred.current = scrollKey;
    node.scrollTop = Math.max(0, index * ROW - node.clientHeight / 2 + ROW * 1.5);
  }, [atmStrike, scrollKey, strikes]);

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(strikes.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const style = { gridTemplateColumns: columns, minWidth } satisfies CSSProperties;

  return (
    <div ref={box} className={cx("relative min-h-0 flex-1 overflow-auto overscroll-contain", className)} onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })} onWheel={(event) => event.stopPropagation()} role="table" aria-label="Option chain" aria-rowcount={strikes.length + 1}>
      <div className="sticky top-0 z-20 grid h-9 items-center border-b border-border bg-panel text-[11px] font-semibold uppercase tracking-wide text-muted" style={style} role="row">
        <span className="px-3 text-left" role="columnheader">Call OI</span>
        <span className="px-2 text-right" role="columnheader">OI chg</span>
        <span className="px-2 text-right" role="columnheader">Volume</span>
        {bidAsk ? <span className="px-2 text-right" role="columnheader">Bid / Ask</span> : null}
        <span className="px-3 text-right" role="columnheader">LTP</span>
        <span className="h-full border-x border-border bg-elevated px-2 text-center leading-9" role="columnheader">Strike</span>
        <span className="px-3 text-left" role="columnheader">LTP</span>
        {bidAsk ? <span className="px-2 text-left" role="columnheader">Bid / Ask</span> : null}
        <span className="px-2 text-left" role="columnheader">Volume</span>
        <span className="px-2 text-left" role="columnheader">OI chg</span>
        <span className="px-3 text-right" role="columnheader">Put OI</span>
      </div>
      {strikes.length === 0 ? (
        loading ? (
          <div aria-hidden>{Array.from({ length: 10 }, (_, index) => <div key={index} className="h-9 border-b border-border px-3 py-2" style={{ minWidth }}><span className="skel block h-full rounded-xs" /></div>)}</div>
        ) : <div className="sticky left-0 px-4 py-10 text-center text-[13px] text-muted">{empty}</div>
      ) : (
        <div className="relative" style={{ height: strikes.length * ROW, minWidth }}>
          {strikes.slice(first, last).map((row, offset) => (
            <ChainRow
              key={row.strike}
              row={row}
              index={first + offset}
              style={style}
              bidAsk={bidAsk}
              maxOi={maxOi}
              atm={row.strike === atmStrike}
              spot={spot}
              actions={actions}
              selected={selected}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const ChainRow = memo(function ChainRow({ row, index, style, bidAsk, maxOi, atm, spot, actions, selected }: { row: ChainStrike; index: number; style: CSSProperties; bidAsk: boolean; maxOi: number; atm: boolean; spot: number | null; actions: ChainActions; selected?: string | null }) {
  const callItm = spot != null && row.strike < spot;
  const putItm = spot != null && row.strike > spot;
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      className={cx("absolute inset-x-0 grid items-center border-b border-border text-data", atm ? "bg-warning/10" : "hover:bg-elevated/60")}
      style={{ ...style, top: index * ROW, height: ROW }}
    >
      <Half right="CE" row={row} side={row.ce} itm={callItm} bidAsk={bidAsk} maxOi={maxOi} actions={actions} selected={selected === `${row.strike}|CE`} />
      <span role="cell" className={cx("flex h-full flex-col items-center justify-center border-x border-border bg-elevated num font-semibold", atm ? "text-warning" : "text-text")}>
        {row.strike.toLocaleString("en-IN")}
        {atm ? <span className="text-[9px] font-semibold uppercase leading-none tracking-wide">ATM</span> : null}
      </span>
      <Half right="PE" row={row} side={row.pe} itm={putItm} bidAsk={bidAsk} maxOi={maxOi} actions={actions} selected={selected === `${row.strike}|PE`} />
    </div>
  );
});

function Half({ right, row, side, itm, bidAsk, maxOi, actions, selected }: { right: Right; row: ChainStrike; side: ChainSide | null; itm: boolean; bidAsk: boolean; maxOi: number; actions: ChainActions; selected: boolean }) {
  const call = right === "CE";
  const width = side?.oi == null ? 0 : Math.max(3, Math.round((side.oi / maxOi) * 100));
  const tint = call ? "var(--loss)" : "var(--profit)";
  const bar = { backgroundImage: `linear-gradient(to ${call ? "left" : "right"}, color-mix(in srgb, ${tint} 22%, transparent) ${width}%, transparent ${width}%)` };
  const change = side?.ltp != null && side.previousClose ? side.ltp - side.previousClose : null;
  const priced = actions.canTrade ? actions.canTrade(right, row.strike, side) : side?.ltp != null;
  const sellable = priced && actions.canSell(right, row.strike);
  const watched = actions.isWatched?.(right, row.strike) ?? false;
  const ltp = (
    <>
      {price(side?.ltp ?? null)}
      {change != null ? <span className={cx("block text-[10px] font-normal leading-none", change > 0 ? "text-profit" : change < 0 ? "text-loss" : "text-muted")}>{change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change).toFixed(2)}</span> : null}
    </>
  );
  const cells = [
    <span key="oi" role="cell" className={cx("num h-full px-3 leading-9", call ? "text-left" : "text-right")} style={bar}>{compact(side?.oi ?? null)}</span>,
    <span key="chg" role="cell" className={cx("num px-2", call ? "text-right" : "text-left", tone(side?.oiChangePct))}>{pct(side?.oiChangePct ?? null)}</span>,
    <span key="vol" role="cell" className={cx("num px-2 text-text-2", call ? "text-right" : "text-left")}>{compact(side?.volume ?? null)}</span>,
    bidAsk ? <span key="ba" role="cell" className={cx("num px-2 text-muted", call ? "text-right" : "text-left")}>{price(side?.bid ?? null)} / {price(side?.ask ?? null)}</span> : null,
    side?.securityId && actions.onChart ? (
      <button key="ltp" type="button" role="cell" title="Open this contract's chart" onClick={() => actions.onChart?.(right, row.strike, side)} className={cx("num h-full px-3 font-semibold hover:text-primary", call ? "text-right" : "text-left", selected ? "text-primary" : "text-text")}>
        {ltp}
      </button>
    ) : (
      <span key="ltp" role="cell" className={cx("num flex h-full flex-col justify-center px-3 font-semibold text-text", call ? "items-end" : "items-start")}>{ltp}</span>
    ),
  ];
  const ordered = call ? cells : [...cells].reverse();
  return (
    <div className={cx("group/half relative grid h-full items-center", itm && "bg-primary/[0.04]")} style={{ gridColumn: call ? `1 / span ${bidAsk ? 5 : 4}` : `${bidAsk ? 7 : 6} / span ${bidAsk ? 5 : 4}`, gridTemplateColumns: "subgrid" }}>
      {ordered}
      {priced ? (
        <span className={cx("absolute top-1/2 z-10 hidden -translate-y-1/2 items-center gap-1 group-hover/half:flex group-focus-within/half:flex", call ? (bidAsk ? "right-[190px]" : "right-[90px]") : bidAsk ? "left-[190px]" : "left-[90px]")}>
          <button type="button" className="h-6 rounded-xs bg-profit px-2 text-[11px] font-bold text-on-signal shadow-e1 hover:brightness-110" aria-label={`Buy ${row.strike} ${right}`} onClick={() => side && actions.onBuy(right, row.strike, side)}>B</button>
          <button type="button" className="h-6 rounded-xs bg-loss px-2 text-[11px] font-bold text-on-signal shadow-e1 hover:brightness-110 disabled:bg-elevated disabled:text-muted disabled:opacity-100" aria-label={`Sell ${row.strike} ${right} to close`} title={sellable ? "Sell to close" : "Sell closes lots you hold. Short options are not available."} disabled={!sellable} onClick={() => side && actions.onSell(right, row.strike, side)}>S</button>
          {actions.onWatch ? (
            <button type="button" className={cx("grid h-6 w-6 place-items-center rounded-xs bg-overlay shadow-e1", watched ? "text-warning" : "text-muted hover:text-text")} aria-label={watched ? `Remove ${row.strike} ${right} from watchlist` : `Add ${row.strike} ${right} to watchlist`} onClick={() => actions.onWatch?.(right, row.strike)}>
              <Star className={cx("h-3.5 w-3.5", watched && "fill-current")} aria-hidden />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function price(value: number | null) {
  return value == null ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function compact(value: number | null) {
  if (value == null) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_00_00_000) return `${(value / 1_00_00_000).toFixed(2)} Cr`;
  if (abs >= 1_00_000) return `${(value / 1_00_000).toFixed(2)} L`;
  return value.toLocaleString("en-IN");
}
function pct(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}%`;
}
function tone(value: number | null | undefined) {
  if (value == null || value === 0 || !Number.isFinite(value)) return "text-muted";
  return value > 0 ? "text-profit" : "text-loss";
}
