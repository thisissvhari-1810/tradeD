import type { Candle } from "@/lib/academy/types";

/** A small drawing of a few candles for a lesson or question (an illustration, not market data). */
export function CandleSketch({ candles, className }: { candles: Candle[]; className?: string }) {
  if (!candles.length) return null;
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const span = Math.max(high - low, 1e-9);
  const width = Math.max(120, candles.length * 34 + 20);
  const height = 120;
  const y = (price: number) => 10 + ((high - price) / span) * (height - 20);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className ?? "h-28 w-full max-w-xs"} role="img" aria-label={`Illustration of ${candles.length} candle${candles.length === 1 ? "" : "s"}`}>
      {candles.map((candle, index) => {
        const x = 20 + index * 34;
        const up = candle.close >= candle.open;
        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        return (
          <g key={index} style={{ color: up ? "var(--profit)" : "var(--loss)" }}>
            <line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <rect x={x - 9} width="18" y={top} height={Math.max(2, bottom - top)} rx="2" fill="currentColor" />
          </g>
        );
      })}
    </svg>
  );
}
