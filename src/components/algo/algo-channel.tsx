"use client";

import { useState } from "react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { Field, Info, NumberInput, type AlgoData } from "@/components/algo/algo-panel";
import { announceSaved } from "@/components/algo/algo-settings-sync";
import { CHANNEL_SETTINGS_DEFAULTS, istClock, type ChannelSettings, type ChannelSetup, type ChannelState, type ChannelZone } from "@/lib/algo/trend-channel";
import type { AlgoConfig, AlgoState } from "@/lib/algo/runner";

const inr = (value: number | null | undefined) => (value == null ? "—" : `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const points = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const slope = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(4)} pts / 3-min candle`;

export const CHANNEL_STATUS_TONE: Record<ChannelSetup["status"], string> = {
  WATCH: "bg-warning-soft text-warning",
  AWAITING: "bg-info-soft text-info",
  RETEST: "bg-info-soft text-info",
  CONFIRMED: "bg-profit-soft text-profit",
  FAILED: "bg-sunken text-muted",
};
const STATUS_LABEL: Record<ChannelSetup["status"], string> = { WATCH: "WATCH", AWAITING: "WAITING FOR NEXT CANDLE", RETEST: "WAITING FOR RETEST", CONFIRMED: "CONFIRMED", FAILED: "NOT CONFIRMED" };

/** The horizontal zone a breakout would have to clear now: the nearest unbroken one (else the furthest broken one). */
export function nearestZone(zones: ChannelZone[], kind: ChannelZone["kind"]) {
  const unbroken = zones.filter((zone) => zone.kind === kind && zone.brokenAt == null).sort((a, b) => (kind === "RESISTANCE" ? a.high - b.high : b.low - a.low));
  return unbroken[0] ?? null;
}

type ChannelPosition = { entryKey: string; side: string; avg: number; quantity: number; target: number; unrealized?: number | null; contract: { strike: number; right: string; expiry: string } };

/**
 * Mathi Trend Channel as it runs (the live panel beside the chart and the chart replay panel): the selected pattern and
 * its swing points, both boundaries' slopes (one value: the clone is the primary's exact parallel copy), the channel
 * width, the horizontal levels, the channel, breakout, confirmation and entry status, and today's setups.
 */
export function ChannelToday({ state, position }: { state: Pick<AlgoState, "analysis" | "lastOrder" | "tradesToday"> | null | undefined; position: ChannelPosition | null }) {
  const channel: ChannelState | null = state?.analysis?.channel ?? null;
  const pattern = channel?.pattern ?? null;
  const primary = channel ? (pattern?.kind === "A" ? channel.upper : channel.lower) : null;
  const clone = channel ? (pattern?.kind === "A" ? channel.lower : channel.upper) : null;
  const resistance = channel ? nearestZone(channel.zones, "RESISTANCE") : null;
  const support = channel ? nearestZone(channel.zones, "SUPPORT") : null;
  const setups = channel?.setups ?? [];
  const latest = [...setups].reverse().find((setup) => setup.status !== "WATCH") ?? null;
  const watch = [...setups].reverse().find((setup) => setup.status === "WATCH") ?? null;
  const point = (label: string) => pattern?.points.find((item) => item.label === label) ?? null;
  const parallel = primary && clone ? Object.is(primary.slope, clone.slope) : null;
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft p-2" aria-label="Mathi Trend Channel status">
        <div className="col-span-2"><p className="eyebrow">Mathi Trend Channel</p></div>
        <Info label="Selected pattern" text={pattern ? (pattern.kind === "A" ? "Pattern A — 2 deep highs + 1 deep low" : "Pattern B — 2 deep lows + 1 deep high") : "Not formed yet"} />
        <Info label="Combination" text={pattern ? pattern.points.map((item) => `${item.label} ${istClock(item.time)}`).join(" → ") : "—"} />
        {(["H1", "H2", "L1", "L2"] as const).map((label) => (point(label) ? <Info key={label} label={label} text={points(point(label)!.price)} tone={label.startsWith("H") ? "text-loss" : "text-profit"} /> : null))}
        <Info label="Primary trendline slope" text={primary ? slope(primary.slope) : "—"} />
        <Info label="Cloned trendline slope" text={clone ? slope(clone.slope) : "—"} />
        <Info label="Parallel check" text={parallel == null ? "—" : parallel ? "Identical slope ✓" : "NOT PARALLEL"} tone={parallel === false ? "text-loss" : parallel ? "text-profit" : undefined} />
        <Info label="Channel width" text={channel?.width != null ? `${points(channel.width)} pts (constant)` : "—"} />
        <Info label="Horizontal resistance" text={resistance ? points(resistance.high) : "—"} tone="text-loss" />
        <Info label="Horizontal support" text={support ? points(support.low) : "—"} tone="text-profit" />
        <Info label="Channel status" text={channel?.now ? `${channel.position === "ABOVE" ? "Above the channel" : channel.position === "BELOW" ? "Below the channel" : "Inside"} · upper ${points(channel.now.upper)} / lower ${points(channel.now.lower)}` : "—"} />
        <Info label="Breakout status" text={latest ? `${latest.direction === "CALL" ? "Bullish breakout" : "Bearish breakdown"} ${istClock(latest.time)} · H ${points(latest.high)} L ${points(latest.low)}` : watch ? `WATCH ${istClock(watch.time)} (channel only)` : "None yet"} />
        <Info label="Confirmation status" text={latest ? STATUS_LABEL[latest.status] : "—"} tone={latest?.status === "CONFIRMED" ? "text-profit" : latest?.status === "FAILED" ? "text-muted" : undefined} />
        <Info label="Trade entry status" text={position ? `ATM ${position.side} ${position.contract.strike} ${position.contract.right} open @ ${inr(position.avg)} → ${inr(position.target)} (${inr(position.unrealized)})` : state?.lastOrder ? state.lastOrder.message.slice(0, 120) : `No entry yet · ${state?.tradesToday ?? 0} today`} />
      </dl>
      <div className="rounded-md border border-border-soft p-2">
        <p className="eyebrow">Today&apos;s channel setups</p>
        <p className="mt-0.5 text-micro text-text-2" role="status">{channel?.status ?? "Waiting for the session: C1 (09:15–09:18) is ignored; the first valid swing combination sets the channel."}</p>
        {setups.length ? (
          <ul className="mt-1 space-y-1.5">
            {setups.map((setup) => (
              <li key={setup.id} className="text-micro leading-snug">
                <span className="flex items-center gap-1.5">
                  <span className={cx("rounded-pill px-1.5 py-0.5 font-semibold", CHANNEL_STATUS_TONE[setup.status])}>{STATUS_LABEL[setup.status]}</span>
                  <span className="font-medium text-text">{istClock(setup.time)} · {setup.direction} · close {points(setup.close)} · line {points(setup.line)}{setup.level != null ? ` · level ${points(setup.level)}` : ""}</span>
                </span>
                {setup.reasons.map((line) => <span key={line} className="block text-muted">{line}</span>)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Mathi Trend Channel in the Strategy box: its rules and its own settings (saved separately from every other
 * strategy). Execution and exits are Mathi Strategy's; the session itself is shown in the panel beside the chart.
 */
export function ChannelRules({ data, onData }: { data: AlgoData; onData: (next: AlgoData) => void }) {
  const own = data.mathiChannel;
  const [draft, setDraft] = useState<AlgoConfig>(own.config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedFor, setSavedFor] = useState(own.config);
  if (savedFor !== own.config && JSON.stringify(savedFor) !== JSON.stringify(own.config)) {
    setSavedFor(own.config);
    if (JSON.stringify(draft) === JSON.stringify(savedFor)) setDraft(own.config);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(own.config);
  const settings: ChannelSettings = { ...CHANNEL_SETTINGS_DEFAULTS, ...draft.channel };
  const channel = (patch: Partial<ChannelSettings>) => setDraft({ ...draft, channel: { ...settings, ...patch } });
  async function save() {
    setBusy(true);
    setError("");
    try {
      const next = await api<AlgoData>("/api/algo", { action: "save", strategy: "MATHI_CHANNEL", config: draft });
      onData(next);
      setDraft(next.mathiChannel.config);
      setSavedFor(next.mathiChannel.config);
      announceSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const config = own.config;
  const saved = { ...CHANNEL_SETTINGS_DEFAULTS, ...config.channel };
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
        <div className="col-span-2"><p className="eyebrow">Mathi Trend Channel — rules</p></div>
        <Info label="Instrument" text="NIFTY 50 ATM CALL / PUT · nearest expiry" />
        <Info label="Timeframe" text="3-minute NIFTY candles (09:15 grid)" />
        <Info label="C1" text="09:15 candle ignored" />
        <Info label="Swings" text={`${saved.left} / ${saved.right} candles, ≥ ${saved.minSwingAtr} × avg range`} />
        <Info label="Pattern A" text="H1 → L1 → H2: line H1–H2, clone through L1" />
        <Info label="Pattern B" text="L1 → H1 → L2: line L1–L2, clone through H1" />
        <Info label="Breakout" text={saved.requireLevel ? "Close beyond the channel and the level" : "Close beyond the channel (research)"} />
        <Info label="Confirmation" text={saved.retest === "instead" ? "Retest of the level, then a close beyond the retest candle" : saved.retest === "after" ? "Next candle beyond the breakout high / low, then a retest" : "Next candle beyond the breakout high / low"} />
        <Info label="Strong candle" text={saved.minBreakoutBody > 0 ? `Breakout body ≥ ${saved.minBreakoutBody}% of its range` : "Off"} />
        <Info label="Momentum" text={saved.minMomentumPercent > 0 ? `NIFTY ≥ ${saved.minMomentumPercent}% your way in 15 min` : "Off"} />
        <Info label="Daily trade" text={saved.fallback === "off" ? "Off" : `At ${saved.fallbackTime} if none yet: ${saved.fallback === "daymove" ? "day's direction" : "price vs channel"}`} />
        <Info label="Target" text={`+${config.target.value}% of the option premium`} tone="text-profit" />
        <Info label="Trades" text={`${config.maxTrades} per session · ${saved.patterns === "both" ? "both patterns" : `Pattern ${saved.patterns} only`}`} />
        <p className="col-span-2 text-micro leading-snug text-muted">
          The first three deep swings after 09:18 (2 highs + 1 low, or 2 lows + 1 high), whichever completes first, set the channel for the day; it is never redrawn with later swings. The second line is an exact parallel clone: the same slope, only moved to the third swing. A close beyond a channel line without the horizontal level is a WATCH (no entry). Exits are Mathi Strategy&apos;s ({config.stopLoss ? "with" : "no"} stop-loss order, +{config.target.value}% target, {config.maxHoldMinutes}-minute checkpoint, {config.squareOff ?? "15:20"} square-off). Paper trading only — no real orders.
        </p>
      </dl>

      {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      <details className="rounded-md border border-border-soft">
        <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Trend Channel settings</summary>
        <div className="space-y-1.5 border-t border-border-soft p-2">
          <p className="eyebrow">Swings and levels</p>
          <Field label="Swing: candles before"><NumberInput value={settings.left} step={1} min={1} onChange={(left) => channel({ left })} /></Field>
          <Field label="Swing: confirming candles after"><NumberInput value={settings.right} step={1} min={1} onChange={(right) => channel({ right })} /></Field>
          <Field label="Deep-swing cutoff (× avg range)"><NumberInput value={settings.minSwingAtr} step={0.25} min={0} onChange={(minSwingAtr) => channel({ minSwingAtr })} /></Field>
          <Field label="Merge levels within (%)"><NumberInput value={settings.zonePercent} step={0.01} min={0} onChange={(zonePercent) => channel({ zonePercent })} /></Field>
          <Field label="Breakout candle body at least (% of range, 0 = off)"><NumberInput value={settings.minBreakoutBody} step={5} min={0} onChange={(minBreakoutBody) => channel({ minBreakoutBody })} /></Field>
          <Field label="15-min momentum at least (% of NIFTY, 0 = off)"><NumberInput value={settings.minMomentumPercent} step={0.01} min={0} onChange={(minMomentumPercent) => channel({ minMomentumPercent })} /></Field>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">No trade on expiry day</span><input type="checkbox" className="oc-check" aria-label="No trade on expiry day" checked={settings.skipExpiryDay} onChange={(event) => channel({ skipExpiryDay: event.target.checked })} /></label>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Opening-gap rule (no CALL on a gap-up, no PUT on a gap-down)</span><input type="checkbox" className="oc-check" aria-label="Opening-gap rule" checked={settings.gapRule} onChange={(event) => channel({ gapRule: event.target.checked })} /></label>
          <Field label="Retest of the broken level">
            <select className="compact-field w-[11rem]" aria-label="Retest" value={settings.retest} onChange={(event) => channel({ retest: event.target.value === "after" ? "after" : event.target.value === "instead" ? "instead" : "off" })}>
              <option value="off">Off (enter on the next candle)</option>
              <option value="after">After the next-candle confirmation</option>
              <option value="instead">Instead of the next-candle confirmation</option>
            </select>
          </Field>
          {settings.retest !== "off" ? <Field label="Retest and move on within (candles)"><NumberInput value={settings.retestCandles} step={1} min={1} onChange={(retestCandles) => channel({ retestCandles })} /></Field> : null}
          {settings.retest !== "off" ? <Field label="Retest tolerance (% of the level)"><NumberInput value={settings.retestTolerancePercent} step={0.01} min={0} onChange={(retestTolerancePercent) => channel({ retestTolerancePercent })} /></Field> : null}
          <Field label="Daily trade if none by the time below">
            <select className="compact-field w-[11rem]" aria-label="Daily trade" value={settings.fallback} onChange={(event) => channel({ fallback: event.target.value === "daymove" ? "daymove" : event.target.value === "channel" ? "channel" : "off" })}>
              <option value="off">Off (only setups)</option>
              <option value="daymove">Day&apos;s direction (vs 09:15 open)</option>
              <option value="channel">Price vs the channel</option>
            </select>
          </Field>
          {settings.fallback !== "off" ? <Field label="Daily trade time (IST)"><input type="time" step={180} className="compact-field w-[9.5rem]" aria-label="Daily trade time" value={settings.fallbackTime} min="09:30" max="15:00" onChange={(event) => channel({ fallbackTime: event.target.value || "14:00" })} /></Field> : null}
          <Field label="Breakout needs">
            <select className="compact-field w-[11rem]" aria-label="Breakout needs" value={settings.requireLevel ? "level" : "channel"} onChange={(event) => channel({ requireLevel: event.target.value === "level" })}>
              <option value="level">Channel + horizontal level</option>
              <option value="channel">Channel only (research)</option>
            </select>
          </Field>
          <Field label="Patterns traded">
            <select className="compact-field w-[11rem]" aria-label="Patterns traded" value={settings.patterns} onChange={(event) => channel({ patterns: event.target.value === "A" ? "A" : event.target.value === "B" ? "B" : "both" })}>
              <option value="both">Pattern A and B</option>
              <option value="A">Pattern A only (2 highs + 1 low)</option>
              <option value="B">Pattern B only (2 lows + 1 high)</option>
            </select>
          </Field>
          <p className="eyebrow pt-2">Trades</p>
          <Field label="Max trades / session"><NumberInput value={draft.maxTrades} step={1} min={1} onChange={(maxTrades) => setDraft({ ...draft, maxTrades })} /></Field>
          <p className="text-micro text-muted">Execution, sizing, target, exits, charges and slippage are Mathi Strategy&apos;s and are not changed here.</p>
          {dirty ? (
            <div className="flex gap-1.5 pt-1">
              <button type="button" className="h-8 flex-1 rounded-md bg-primary font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save Trend Channel settings"}</button>
              <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setDraft(own.config)}>Undo</button>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
