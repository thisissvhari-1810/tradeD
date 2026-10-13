"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IChartApi, ISeriesApi, Logical, SeriesType, UTCTimestamp } from "lightweight-charts";
import { FIB_EXTENSION_RATIOS, barsBetween, fibLevels, fibTimes, measureGestureDown, measureGestureFinish, measureGestureMove, measureLines, measureStats, measureTone, overRightPriceScale, placeMeasureCard, pointsNeeded, positionStats, screenAngle, shiftDrawing, zoomPriceRange, type Drawing, type DrawTool, type MeasureGesture, type Point } from "@/components/drawing-model";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

type MarkStyle = { stroke?: number; pattern?: "solid" | "dashed" | "dotted" };
type Mark = (
  | { id: string; kind: "segment"; x1: number; y1: number; x2: number; y2: number; color: string; selected: boolean; dash?: boolean }
  | { id: string; kind: "hline"; y: number; color: string; label: string; selected: boolean }
  | { id: string; kind: "poly"; d: string; color: string; selected: boolean; opacity?: number }
  | { id: string; kind: "text"; x: number; y: number; text: string; color: string; selected: boolean }
  | { id: string; kind: "dot"; x: number; y: number; color: string; selected: boolean }
  | { id: string; kind: "vline"; x: number; color: string; selected: boolean }
  | { id: string; kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; color: string; fill: string; selected: boolean }
  | { id: string; kind: "handle"; x: number; y: number; selected: boolean }
  | { id: string; kind: "box"; x: number; y: number; width: number; height: number; fill: string; color: string; selected: boolean }
  | { id: string; kind: "card"; x: number; y: number; width: number; height: number; lines: string[]; color: string; selected: boolean }
  | { id: string; kind: "profile"; x: number; y: number; width: number; color: string; selected: boolean }
) & MarkStyle;

export function DrawingLayer({
  chartRef,
  seriesRef,
  candles,
  drawings,
  onDrawings,
  tool,
  magnet,
  hidden,
  annotation,
  command,
  enabled,
  onTool,
  onSelect,
  ready = 0,
}: {
  chartRef: { current: IChartApi | null };
  seriesRef: { current: ISeriesApi<SeriesType> | null };
  candles: Bar[];
  drawings: Drawing[];
  onDrawings: (next: Drawing[], undo?: boolean) => void;
  tool: DrawTool;
  magnet: boolean;
  hidden: boolean;
  annotation: string;
  command: { id: number; name: "lock" | "trash" | "color" } | null;
  enabled: boolean;
  onTool: (tool: DrawTool) => void;
  onSelect?: (id: string | null) => void;
  ready?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<() => void>(() => undefined);
  const drawingsRef = useRef(drawings);
  const toolRef = useRef(tool);
  const magnetRef = useRef(magnet);
  const annotationRef = useRef(annotation);
  const onDrawingsRef = useRef(onDrawings);
  const onToolRef = useRef(onTool);
  const onSelectRef = useRef(onSelect);
  const draftRef = useRef<Point[]>([]);
  const previewRef = useRef<Point | null>(null);
  const selectedRef = useRef<string | null>(null);
  const brushing = useRef<Point[] | null>(null);
  const measureDrag = useRef<MeasureGesture | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  drawingsRef.current = drawings;
  toolRef.current = tool;
  magnetRef.current = magnet;
  annotationRef.current = annotation;
  onDrawingsRef.current = onDrawings;
  onToolRef.current = onTool;
  onSelectRef.current = onSelect;
  selectedRef.current = selected;

  function project() {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || hidden) {
      setMarks([]);
      return;
    }
    const scale = chart.timeScale();
    const step = barStep(candles);
    const xy = (point: Point) => {
      let x = scale.timeToCoordinate(point.time as UTCTimestamp);
      const y = series.priceToCoordinate(point.price);
      if (x == null && candles.length && step > 0) {
        const last = candles[candles.length - 1].time;
        const logical = (candles.length - 1) + (point.time - last) / step;
        x = scale.logicalToCoordinate(logical as Logical);
      }
      return x == null || y == null ? null : { x, y };
    };
    const next: Mark[] = [];
    const show = [...drawingsRef.current];
    const preview = previewShape();
    if (preview) show.push(preview);
    for (const drawing of show) {
      if (drawing.hidden && drawing.id !== "preview") continue;
      const active = drawing.id === selectedRef.current;
      const from = next.length;
      if ((drawing.kind === "hline" || drawing.kind === "hray") && drawing.points[0]) {
        const y = series.priceToCoordinate(drawing.points[0].price);
        if (y != null && drawing.kind === "hline") next.push({ id: drawing.id, kind: "hline", y, color: drawing.color, label: drawing.points[0].price.toFixed(2), selected: active });
        if (drawing.kind === "hray") pushSegment(next, drawing.id, drawing.points[0], { time: drawing.points[0].time + barStep(candles) * 80, price: drawing.points[0].price }, drawing.color, active, xy, drawing.dash === "dashed");
      } else if ((drawing.kind === "text" || drawing.kind === "note" || drawing.kind === "price" || drawing.kind === "callout") && drawing.points[0]) {
        const at = xy(drawing.points[0]);
        if (at) {
          const label = drawing.kind === "price" ? (drawing.text || drawing.points[0].price.toFixed(2)) : (drawing.text || "Note");
          if (drawing.kind === "note" || drawing.kind === "price" || drawing.kind === "callout") next.push({ id: `${drawing.id}-bg`, kind: "box", x: at.x - 4, y: drawing.kind === "callout" ? at.y - 36 : at.y - 16, width: Math.max(48, label.length * 7), height: 20, fill: "#141A26", color: drawing.color, selected: active });
          if (drawing.kind === "callout") next.push({ id: `${drawing.id}-stem`, kind: "segment", x1: at.x, y1: at.y, x2: at.x, y2: at.y - 16, color: drawing.color, selected: active });
          next.push({ id: drawing.id, kind: "text", x: at.x, y: drawing.kind === "callout" ? at.y - 22 : at.y, text: label, color: drawing.color, selected: active });
        }
      } else if (drawing.kind === "marker" && drawing.points[0]) {
        const at = xy(drawing.points[0]);
        if (at) {
          next.push({ id: drawing.id, kind: "dot", x: at.x, y: at.y, color: drawing.color, selected: active });
          if (drawing.text) next.push({ id: `${drawing.id}-glyph`, kind: "text", x: at.x + 8, y: at.y + 4, text: drawing.text, color: drawing.color, selected: active });
        }
      } else if (drawing.kind === "range" && drawing.points.length >= 2) {
        pushRange(next, drawing, xy, candles, active, hostRef.current);
      } else if ((drawing.kind === "path" || drawing.kind === "brush") && drawing.points.length > 1) {
        const d = drawing.points.flatMap((point, index) => {
          const at = xy(point);
          return at ? [`${index === 0 ? "M" : "L"}${at.x},${at.y}`] : [];
        }).join(" ");
        if (d) next.push({ id: drawing.id, kind: "poly", d, color: drawing.color, selected: active });
      } else if ((drawing.kind === "fib" || drawing.kind === "fibext") && drawing.points.length >= 2) {
        for (const level of fibLevels(drawing.points[0].price, drawing.points[1].price, drawing.kind === "fibext" ? FIB_EXTENSION_RATIOS : undefined)) {
          const y = series.priceToCoordinate(level.price);
          if (y != null) next.push({ id: `${drawing.id}-${level.ratio}`, kind: "hline", y, color: drawing.color, label: `${(level.ratio * 100).toFixed(1)}% ${level.price.toFixed(2)}`, selected: active });
        }
      } else if (drawing.kind === "fibtime" && drawing.points.length >= 2) {
        for (const zone of fibTimes(drawing.points[0].time, drawing.points[1].time)) {
          const at = xy({ time: zone.time, price: drawing.points[0].price });
          if (at) next.push({ id: `${drawing.id}-t${zone.ratio}`, kind: "vline", x: at.x, color: drawing.color, selected: active });
        }
      } else if (drawing.kind === "channel" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy);
        const offset = (drawing.points[2]?.price ?? drawing.points[0].price) - drawing.points[0].price;
        pushSegment(next, `${drawing.id}-b`, { time: drawing.points[0].time, price: drawing.points[0].price + offset }, { time: drawing.points[1].time, price: drawing.points[1].price + offset }, drawing.color, active, xy);
      } else if ((drawing.kind === "long" || drawing.kind === "short") && drawing.points.length >= 2) {
        pushPosition(next, drawing, xy, series);
      } else if (drawing.kind === "forecast" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy, true);
      } else if (drawing.kind === "projection" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy);
        const extend = {
          time: drawing.points[1].time + (drawing.points[1].time - drawing.points[0].time),
          price: drawing.points[1].price + (drawing.points[1].price - drawing.points[0].price),
        };
        pushSegment(next, `${drawing.id}-ext`, drawing.points[1], extend, drawing.color, active, xy, true);
      } else if (drawing.kind === "avwap" && drawing.points[0]) {
        pushPoly(next, drawing.id, anchoredVwap(candles, drawing.points[0].time), "#089981", active, xy);
      } else if ((drawing.kind === "bars" || drawing.kind === "ghost") && drawing.points.length >= 2) {
        pushPoly(next, drawing.id, patternLine(candles, drawing.points[0].time, drawing.points[1].time, drawing.kind === "ghost"), drawing.color, active, xy, drawing.kind === "ghost" ? 0.45 : 1);
      } else if (drawing.kind === "vprofile" && drawing.points.length >= 2) {
        pushProfile(next, drawing, candles, xy);
      } else if ((drawing.kind === "ray" || drawing.kind === "extended") && drawing.points.length >= 2) {
        const forward = farPoint(drawing.points[0], drawing.points[1], 40);
        const backward = farPoint(drawing.points[1], drawing.points[0], 40);
        if (drawing.kind === "extended") pushSegment(next, drawing.id, backward, forward, drawing.color, active, xy, drawing.dash === "dashed");
        else pushSegment(next, drawing.id, drawing.points[0], forward, drawing.color, active, xy, drawing.dash === "dashed");
      } else if (drawing.kind === "vline" && drawing.points[0]) {
        const at = xy(drawing.points[0]);
        if (at) next.push({ id: drawing.id, kind: "vline", x: at.x, color: drawing.color, selected: active });
      } else if ((drawing.kind === "rect" || drawing.kind === "ellipse") && drawing.points.length >= 2) {
        pushClosed(next, drawing, xy, active);
      } else if (drawing.kind === "triangle" && drawing.points.length >= 3) {
        pushPoly(next, drawing.id, [...drawing.points, drawing.points[0]], drawing.color, active, xy);
      } else if (drawing.kind === "arrow" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy, drawing.dash === "dashed");
        pushArrowHead(next, drawing, xy);
      } else if (drawing.kind === "angle" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy);
        const left = xy(drawing.points[0]);
        const right = xy(drawing.points[1]);
        if (left && right) next.push({ id: `${drawing.id}-angle`, kind: "text", x: right.x, y: right.y - 8, text: `${screenAngle(right.x - left.x, right.y - left.y).toFixed(1)}°`, color: drawing.color, selected: active });
      } else if (drawing.points.length >= 2 && drawing.kind !== "hray") {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy, drawing.dash === "dashed");
        if (drawing.kind === "measure") {
          const at = xy(drawing.points[1]);
          const from = Math.min(drawing.points[0].time, drawing.points[1].time);
          const to = Math.max(drawing.points[0].time, drawing.points[1].time);
          const bars = candles.filter((candle) => candle.time >= from && candle.time <= to).length;
          const stats = measureStats(drawing.points[0], drawing.points[1], bars);
          if (at) next.push({ id: `${drawing.id}-label`, kind: "text", x: at.x, y: at.y - 8, text: `${stats.change >= 0 ? "+" : ""}${stats.change.toFixed(2)} (${stats.percent >= 0 ? "+" : ""}${stats.percent.toFixed(2)}%) · ${stats.bars} bars · ${formatSpan(stats.seconds)}`, color: drawing.color, selected: active });
        }
      }
      const drawn = next.length;
      for (let index = from; index < drawn; index += 1) {
        const mark = next[index];
        const forced = "dash" in mark && mark.dash;
        next[index] = { ...mark, stroke: drawing.width ?? 1.5, pattern: forced ? "dashed" : (drawing.dash ?? "solid") };
      }
      if (active && drawing.id !== "preview") {
        drawing.points.forEach((point, index) => {
          const at = xy(point);
          if (at) next.push({ id: `${drawing.id}#${index}`, kind: "handle", x: at.x, y: at.y, selected: true });
        });
      }
    }
    setMarks(next);
  }
  projectRef.current = project;

  function previewShape(): Drawing | null {
    const draft = draftRef.current;
    const preview = previewRef.current;
    const active = toolRef.current;
    if (!draft.length || !preview) return null;
    const points = [...draft, preview];
    if (pointsNeeded(active) >= 2) return { id: "preview", kind: active as Drawing["kind"], points, color: "#9598A1", locked: false };
    return null;
  }

  useEffect(() => {
    project();
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = () => project();
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.timeScale().subscribeSizeChange(onRange);
    const onClick = () => { setSelected(null); onSelectRef.current?.(null); };
    chart.subscribeClick(onClick);
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.timeScale().unsubscribeSizeChange(onRange);
      chart.unsubscribeClick(onClick);
    };
  }, [candles, drawings, hidden, selected, tool, ready]);

  useEffect(() => {
    if (!enabled || !command) return;
    const current = drawingsRef.current;
    if (command.name === "trash") {
      const id = selectedRef.current;
      if (id) {
        const item = current.find((drawing) => drawing.id === id);
        if (item && !item.locked) onDrawingsRef.current(current.filter((drawing) => drawing.id !== id), true);
        setSelected(null);
      } else if (window.confirm("Remove all drawings for this symbol? Orders and balances stay.")) {
        onDrawingsRef.current([], true);
      }
    } else if (command.name === "lock") {
      const id = selectedRef.current;
      if (id) onDrawingsRef.current(current.map((drawing) => drawing.id === id ? { ...drawing, locked: !drawing.locked } : drawing), true);
      else {
        const unlock = current.length > 0 && current.every((drawing) => drawing.locked);
        onDrawingsRef.current(current.map((drawing) => ({ ...drawing, locked: !unlock })), true);
      }
    } else if (command.name === "color" && selectedRef.current) {
      onDrawingsRef.current(current.map((drawing) => drawing.id === selectedRef.current ? { ...drawing, color: nextColor(drawing.color) } : drawing), true);
    }
  }, [command, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (event.key === "Escape") {
        measureDrag.current = null;
        draftRef.current = [];
        previewRef.current = null;
        setSelected(null);
        onSelectRef.current?.(null);
        onToolRef.current("cursor");
        project();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedRef.current) {
        const item = drawingsRef.current.find((drawing) => drawing.id === selectedRef.current);
        if (item && !item.locked) onDrawingsRef.current(drawingsRef.current.filter((drawing) => drawing.id !== item.id), true);
        setSelected(null);
        onSelectRef.current?.(null);
      }
      if (event.key === "Enter" && toolRef.current === "path" && draftRef.current.length >= 2) {
        commit(draftRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  function commit(points: Point[], kind: Drawing["kind"] = toolRef.current as Drawing["kind"]) {
    const typed = annotationRef.current.trim();
    const text = kind === "price" ? (typed || points[0]?.price.toFixed(2) || "") : kind === "marker" ? typed : (typed || "Note");
    const drawing: Drawing = { id: crypto.randomUUID(), kind, points, text, color: "#D4AF37", width: 1.5, dash: "solid", locked: false };
    onDrawingsRef.current([...drawingsRef.current, drawing], true);
    draftRef.current = [];
    previewRef.current = null;
    brushing.current = null;
    measureDrag.current = null;
    project();
  }

  function read(event: { clientX: number; clientY: number }): Point | null {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const host = hostRef.current;
    if (!chart || !series || !host) return null;
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const located = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (price == null) return null;
    let time: number;
    if (typeof located === "number") time = located;
    else {
      const logical = chart.timeScale().coordinateToLogical(x);
      const step = barStep(candles);
      if (logical == null || !candles.length || step <= 0) return null;
      time = candles[candles.length - 1].time + (logical - (candles.length - 1)) * step;
    }
    if (!magnetRef.current || !candles.length) return { time, price };
    const bar = candles.reduce((best, candle) => Math.abs(candle.time - time) < Math.abs(best.time - time) ? candle : best);
    const snap = [bar.open, bar.high, bar.low, bar.close].reduce((best, value) => Math.abs(value - price) < Math.abs(best - price) ? value : best);
    return { time: bar.time, price: snap };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const point = read(event);
    if (!point) return;
    if (toolRef.current === "range") {
      measureDrag.current = measureGestureDown(point);
      draftRef.current = [point];
      previewRef.current = point;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The pointer already ended. */ }
      project();
      return;
    }
    if (toolRef.current === "brush") {
      brushing.current = [point];
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (toolRef.current === "zoom") {
      brushing.current = [point];
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = read(event);
    if (measureDrag.current) {
      if (!point) return;
      measureDrag.current = measureGestureMove(measureDrag.current, point);
      draftRef.current = [measureDrag.current.start];
      previewRef.current = point;
      project();
      return;
    }
    if (!point) return;
    if (brushing.current && toolRef.current === "brush") {
      const last = brushing.current[brushing.current.length - 1];
      if (Math.abs(point.price - last.price) > 0 || point.time !== last.time) brushing.current.push(point);
      draftRef.current = brushing.current;
      previewRef.current = null;
      project();
      return;
    }
    previewRef.current = point;
    if (draftRef.current.length) project();
  }

  function finishMeasure(point: Point | null) {
    const drag = measureDrag.current;
    if (!drag) return false;
    measureDrag.current = null;
    const finished = measureGestureFinish(point ? measureGestureMove(drag, point) : drag);
    draftRef.current = [];
    previewRef.current = null;
    if (finished) commit(finished, "range");
    else project();
    return true;
  }

  function onPointerCancel() {
    if (!measureDrag.current) return;
    measureDrag.current = null;
    draftRef.current = [];
    previewRef.current = null;
    project();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const point = read(event);
    if (finishMeasure(point)) return;
    const active = toolRef.current;
    if (active === "brush" && brushing.current && brushing.current.length > 1) {
      commit(brushing.current, "brush");
      return;
    }
    if (active === "zoom" && brushing.current && point && chartRef.current) {
      const from = Math.min(brushing.current[0].time, point.time);
      const to = Math.max(brushing.current[0].time, point.time);
      if (to > from) chartRef.current.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp });
      brushing.current = null;
      return;
    }
    brushing.current = null;
    if (!point) return;
    const needed = pointsNeeded(active);
    if (needed === 1) commit([point], active as Drawing["kind"]);
    else if (needed === 2 || needed === 3) {
      draftRef.current = [...draftRef.current, point];
      if (draftRef.current.length >= needed) commit(draftRef.current.slice(0, needed), active as Drawing["kind"]);
    } else if (active === "path") {
      draftRef.current = [...draftRef.current, point];
    }
    previewRef.current = point;
    project();
  }

  function startDrag(id: string, event: ReactPointerEvent) {
    event.stopPropagation();
    event.preventDefault();
    const handle = id.split("#");
    const pointIndex = handle.length > 1 ? Number(handle[1]) : undefined;
    const lookup = handle[0];
    const drawing = drawingsRef.current.find((item) => item.id === lookup || lookup.startsWith(`${item.id}-`) || lookup.startsWith(`${item.id}#`));
    const realId = drawing?.id;
    if (!realId) return;
    setSelected(realId);
    onSelectRef.current?.(realId);
    if (!drawing || drawing.locked || toolRef.current !== "cursor") return;
    const origin = read(event);
    if (!origin) return;
    const snapshot = drawing.points.map((point) => ({ ...point }));
    let saved = false;
    const move = (ev: PointerEvent) => {
      const now = read(ev);
      if (!now) return;
      const shifted = shiftDrawing({ ...drawing, points: snapshot }, now.time - origin.time, now.price - origin.price, Number.isFinite(pointIndex) ? pointIndex : undefined);
      onDrawingsRef.current(drawingsRef.current.map((item) => item.id === realId ? shifted : item), !saved);
      saved = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  useEffect(() => {
    const host = hostRef.current;
    const parent = host?.parentElement;
    const chartNode = host?.previousElementSibling;
    if (!parent || !chartNode) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.isTrusted) return;
      if (measureDrag.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const chart = chartRef.current;
      const series = seriesRef.current;
      if (!chart || !series) return;
      const rect = chartNode.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const scaleWidth = series.priceScale().width();
      if (event.deltaY !== 0 && overRightPriceScale(x, rect.width, scaleWidth)) {
        event.preventDefault();
        event.stopPropagation();
        const scale = series.priceScale();
        const range = scale.getVisibleRange();
        if (!range) return;
        scale.setAutoScale(false);
        scale.setVisibleRange(zoomPriceRange(range.from, range.to, event.deltaY, event.deltaMode));
        projectRef.current();
        return;
      }
      if (toolRef.current === "cursor") return;
      event.preventDefault();
      chartNode.dispatchEvent(new WheelEvent("wheel", {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        bubbles: true,
        cancelable: true,
      }));
    };
    parent.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => parent.removeEventListener("wheel", onWheel, { capture: true });
  }, [ready]);

  useEffect(() => {
    if (tool === "range" || !measureDrag.current) return;
    measureDrag.current = null;
    draftRef.current = [];
    previewRef.current = null;
    projectRef.current();
  }, [tool]);

  const capturing = enabled && tool !== "cursor";
  return (
    <div ref={hostRef} className="absolute inset-0 z-10" style={{ pointerEvents: capturing ? "auto" : "none", touchAction: capturing ? "none" : "auto", cursor: capturing ? "crosshair" : "default" }} onPointerDown={capturing ? onPointerDown : undefined} onPointerMove={capturing ? onPointerMove : undefined} onPointerUp={capturing ? onPointerUp : undefined} onPointerCancel={capturing ? onPointerCancel : undefined} onDoubleClick={capturing && tool === "path" ? () => { if (draftRef.current.length >= 2) commit(draftRef.current, "path"); } : undefined}>
      <svg className="h-full w-full" style={{ pointerEvents: "none" }}>
        {capturing ? <rect x="0" y="0" width="100%" height="100%" fill="transparent" style={{ pointerEvents: "all" }} /> : null}
        {marks.map((mark) => {
          const width = mark.selected ? Math.max(mark.stroke ?? 1.5, 2.2) : (mark.stroke ?? 1.5);
          const dash = mark.pattern === "dashed" ? "6 4" : mark.pattern === "dotted" ? "1.5 3" : undefined;
          if (mark.kind === "hline") {
            return (
              <g key={mark.id} style={{ pointerEvents: tool === "cursor" ? "auto" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)}>
                <line x1="0" x2="100%" y1={mark.y} y2={mark.y} stroke={mark.color} strokeWidth={width} strokeDasharray={dash} />
                <text x="8" y={mark.y - 4} fill={mark.color} fontSize="11">{mark.label}</text>
              </g>
            );
          }
          if (mark.kind === "vline") {
            return <line key={mark.id} x1={mark.x} x2={mark.x} y1="0" y2="100%" stroke={mark.color} strokeWidth={width} strokeDasharray={dash} style={{ pointerEvents: tool === "cursor" ? "stroke" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          if (mark.kind === "ellipse") {
            return <ellipse key={mark.id} cx={mark.cx} cy={mark.cy} rx={mark.rx} ry={mark.ry} fill={mark.fill} stroke={mark.color} strokeWidth={width} style={{ pointerEvents: tool === "cursor" ? "auto" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          if (mark.kind === "handle") {
            return <circle key={mark.id} cx={mark.x} cy={mark.y} r="4" fill="#F8FAFC" stroke="#0A0D14" strokeWidth="1" style={{ pointerEvents: "auto" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          if (mark.kind === "box") {
            return <rect key={mark.id} x={mark.x} y={mark.y} width={mark.width} height={mark.height} fill={mark.fill} stroke={mark.color} strokeWidth={width} style={{ pointerEvents: tool === "cursor" ? "auto" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          if (mark.kind === "card") {
            return (
              <g key={mark.id} style={{ pointerEvents: tool === "cursor" ? "auto" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)}>
                <rect x={mark.x} y={mark.y} width={mark.width} height={mark.height} rx="4" fill="#141A26" stroke={mark.color} />
                {mark.lines.map((line, index) => <text key={line} x={mark.x + 8} y={mark.y + 16 + index * 14} fill={line.startsWith("Direction") || line.startsWith("Price Change") || line.startsWith("Percentage") ? mark.color : "#F8FAFC"} fontSize="11">{line}</text>)}
              </g>
            );
          }
          if (mark.kind === "profile") {
            return <rect key={mark.id} x={mark.x} y={mark.y} width={mark.width} height={8} fill={mark.color} opacity={0.55} style={{ pointerEvents: tool === "cursor" ? "auto" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          if (mark.kind === "segment") {
            return <line key={mark.id} x1={mark.x1} y1={mark.y1} x2={mark.x2} y2={mark.y2} stroke={mark.color} strokeWidth={width} strokeDasharray={dash} style={{ pointerEvents: tool === "cursor" ? "stroke" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          if (mark.kind === "poly") {
            return <path key={mark.id} d={mark.d} fill="none" stroke={mark.color} strokeWidth={width} strokeDasharray={dash} opacity={mark.opacity ?? 1} style={{ pointerEvents: tool === "cursor" ? "stroke" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          if (mark.kind === "dot") {
            return <circle key={mark.id} cx={mark.x} cy={mark.y} r={mark.selected ? 6 : 4} fill={mark.color} style={{ pointerEvents: tool === "cursor" ? "auto" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)} />;
          }
          return <text key={mark.id} x={mark.x} y={mark.y} fill={mark.color} fontSize="12" style={{ pointerEvents: tool === "cursor" ? "auto" : "none" }} onPointerDown={(event) => startDrag(mark.id, event)}>{mark.text}</text>;
        })}
      </svg>
    </div>
  );
}

function pushRange(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, candles: Bar[], selected: boolean, host: HTMLElement | null) {
  const left = xy(drawing.points[0]);
  const right = xy(drawing.points[1]);
  if (!left || !right) return;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const width = Math.max(8, Math.abs(right.x - left.x));
  const height = Math.max(8, Math.abs(right.y - left.y));
  const stats = measureStats(drawing.points[0], drawing.points[1], barsBetween(drawing.points[0].time, drawing.points[1].time, barStep(candles), candles.map((candle) => candle.time)));
  const tone = measureTone(stats.up);
  const lines = measureLines(stats);
  const bounds = { width: host?.clientWidth || 0, height: host?.clientHeight || 0 };
  const card = placeMeasureCard(
    { x, y, width, height },
    { width: Math.max(168, ...lines.map((line) => line.length * 6.5 + 16)), height: lines.length * 14 + 12 },
    bounds.width > 0 && bounds.height > 0 ? bounds : { width: 10_000, height: 10_000 },
  );
  marks.push({ id: drawing.id, kind: "box", x, y, width, height, fill: `${tone}33`, color: tone, selected });
  marks.push({ id: `${drawing.id}-start`, kind: "dot", x: left.x, y: left.y, color: tone, selected });
  marks.push({ id: `${drawing.id}-end`, kind: "dot", x: right.x, y: right.y, color: tone, selected });
  marks.push({ id: `${drawing.id}-card`, kind: "card", x: card.x, y: card.y, width: card.width, height: card.height, lines, color: tone, selected });
}

function farPoint(from: Point, to: Point, times: number): Point {
  return { time: to.time + (to.time - from.time) * times, price: to.price + (to.price - from.price) * times };
}

function formatSpan(seconds: number) {
  const abs = Math.abs(seconds);
  if (abs >= 86400) return `${Math.round(abs / 86400)}d`;
  if (abs >= 3600) return `${Math.round(abs / 3600)}h`;
  if (abs >= 60) return `${Math.round(abs / 60)}m`;
  return `${Math.round(abs)}s`;
}

function pushClosed(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, selected: boolean) {
  const left = xy(drawing.points[0]);
  const right = xy(drawing.points[1]);
  if (!left || !right) return;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const width = Math.max(2, Math.abs(right.x - left.x));
  const height = Math.max(2, Math.abs(right.y - left.y));
  if (drawing.kind === "ellipse") {
    marks.push({ id: drawing.id, kind: "ellipse", cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2, color: drawing.color, fill: `${drawing.color}22`, selected });
    return;
  }
  marks.push({ id: drawing.id, kind: "box", x, y, width, height, fill: `${drawing.color}22`, color: drawing.color, selected });
}

function pushArrowHead(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null) {
  const left = xy(drawing.points[0]);
  const right = xy(drawing.points[1]);
  if (!left || !right) return;
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const size = 12;
  const a = { x: right.x - size * Math.cos(angle - 0.45), y: right.y - size * Math.sin(angle - 0.45) };
  const b = { x: right.x - size * Math.cos(angle + 0.45), y: right.y - size * Math.sin(angle + 0.45) };
  marks.push({ id: `${drawing.id}-head`, kind: "poly", d: `M${a.x},${a.y} L${right.x},${right.y} L${b.x},${b.y}`, color: drawing.color, selected: false });
}

function pushSegment(marks: Mark[], id: string, a: Point, b: Point, color: string, selected: boolean, xy: (point: Point) => { x: number; y: number } | null, dash = false) {
  const left = xy(a);
  const right = xy(b);
  if (left && right) marks.push({ id, kind: "segment", x1: left.x, y1: left.y, x2: right.x, y2: right.y, color, selected, dash });
}

function pushPoly(marks: Mark[], id: string, points: Point[], color: string, selected: boolean, xy: (point: Point) => { x: number; y: number } | null, opacity = 1) {
  const d = points.flatMap((point, index) => {
    const at = xy(point);
    return at ? [`${index === 0 ? "M" : "L"}${at.x},${at.y}`] : [];
  }).join(" ");
  if (d) marks.push({ id, kind: "poly", d, color, selected, opacity });
}

function pushPosition(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, series: ISeriesApi<SeriesType>) {
  const entry = drawing.points[0];
  const other = drawing.points[1];
  const third = drawing.points[2];
  const span = Math.abs(other.price - entry.price) || Math.abs(entry.price) * 0.01;
  const stop = third ? other.price : drawing.kind === "long" ? (other.price >= entry.price ? entry.price - span : other.price) : (other.price <= entry.price ? entry.price + span : other.price);
  const target = third ? third.price : drawing.kind === "long" ? (other.price >= entry.price ? other.price : entry.price + span) : (other.price <= entry.price ? other.price : entry.price - span);
  const stats = positionStats(entry.price, stop, target);
  const leftTime = Math.min(...drawing.points.map((point) => point.time));
  const rightTime = Math.max(...drawing.points.map((point) => point.time));
  const left = xy({ time: leftTime, price: entry.price });
  const right = xy({ time: rightTime, price: entry.price });
  const targetY = series.priceToCoordinate(target);
  const stopY = series.priceToCoordinate(stop);
  const entryY = series.priceToCoordinate(entry.price);
  if (!left || !right || targetY == null || stopY == null || entryY == null) return;
  const x = Math.min(left.x, right.x);
  const width = Math.max(24, Math.abs(right.x - left.x));
  const reward = "#089981";
  const risk = "#F23645";
  const targetColor = drawing.kind === "long" ? reward : risk;
  const stopColor = drawing.kind === "long" ? risk : reward;
  marks.push(box(drawing.id, x, entryY, targetY, width, targetColor, drawing.id === "preview"));
  marks.push(box(`${drawing.id}-stop`, x, entryY, stopY, width, stopColor, false));
  marks.push({ id: `${drawing.id}-label`, kind: "text", x: x + 6, y: Math.min(targetY, stopY, entryY) - 6, text: `${drawing.kind === "long" ? "Long" : "Short"} · entry ${entry.price.toFixed(2)} · stop ${stop.toFixed(2)} (${stats.riskPercent.toFixed(2)}%) · target ${target.toFixed(2)} (${stats.rewardPercent.toFixed(2)}%) · R ${stats.ratio.toFixed(2)}`, color: targetColor, selected: false });
}

function box(id: string, x: number, y1: number, y2: number, width: number, color: string, selected: boolean): Mark {
  const y = Math.min(y1, y2);
  return { id, kind: "box", x, y, width, height: Math.max(2, Math.abs(y2 - y1)), fill: `${color}33`, color, selected };
}

function pushProfile(marks: Mark[], drawing: Drawing, candles: Bar[], xy: (point: Point) => { x: number; y: number } | null) {
  const from = Math.min(drawing.points[0].time, drawing.points[1].time);
  const to = Math.max(drawing.points[0].time, drawing.points[1].time);
  const slice = candles.filter((candle) => candle.time >= from && candle.time <= to);
  if (!slice.length) return;
  const low = Math.min(...slice.map((candle) => candle.low));
  const high = Math.max(...slice.map((candle) => candle.high));
  const bins = 16;
  const step = (high - low) / bins || 1;
  const volumes = Array.from({ length: bins }, () => 0);
  for (const candle of slice) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((candle.close - low) / step)));
    volumes[index] += candle.volume || 1;
  }
  const peak = Math.max(...volumes, 1);
  const origin = xy({ time: to, price: low });
  if (!origin) return;
  volumes.forEach((volume, index) => {
    const price = low + (index + 0.5) * step;
    const at = xy({ time: to, price });
    if (!at) return;
    marks.push({ id: `${drawing.id}-${index}`, kind: "profile", x: at.x, y: at.y - 4, width: Math.max(2, (volume / peak) * 96), color: "#D4AF37", selected: false });
  });
}

function barStep(candles: Bar[]) {
  if (candles.length < 2) return 86_400;
  return Math.max(60, candles[candles.length - 1].time - candles[candles.length - 2].time);
}

function patternLine(candles: Bar[], from: number, to: number, ghost: boolean): Point[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const slice = candles.filter((candle) => candle.time >= start && candle.time <= end);
  if (slice.length < 2) return [];
  const step = barStep(candles);
  const origin = ghost ? end + slice.length * step : end;
  return slice.map((candle, index) => ({ time: origin + index * step, price: candle.close }));
}

function anchoredVwap(candles: Bar[], anchor: number): Point[] {
  let priceVolume = 0;
  let volume = 0;
  const line: Point[] = [];
  for (const candle of candles) {
    if (candle.time < anchor) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    const size = candle.volume || 1;
    priceVolume += typical * size;
    volume += size;
    line.push({ time: candle.time, price: priceVolume / volume });
  }
  return line;
}

function nextColor(color: string) {
  const index = ["#D4AF37", "#10B981", "#EF4444", "#F0B90B", "#F8FAFC"].indexOf(color);
  return ["#D4AF37", "#10B981", "#EF4444", "#F0B90B", "#F8FAFC"][(index + 1) % 5];
}
