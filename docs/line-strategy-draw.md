# Line Strategy Draw

**Strategy** controls what the trading system runs. **Line Strategy Draw** controls which strategies' lines appear on the chart. They are separate features. Line Strategy Draw never turns a strategy or algo on or off, and never changes how levels are calculated.

## What users can do

The panel lists every strategy that has lines on the index chart, each with its own on/off switch:

| Strategy | Lines (default on) | Optional lines |
|---|---|---|
| Mathi Strategy | Previous-day box A (top / mid / bottom), today's-open box B (top / mid / bottom), 9:15 high / low | Open, PDH / PDL / PDC |
| Mathi Hourly Zone Strategy — 5% | Reference (09:15 hour close), 09:15 hour high / low, 10:15 hour high / low | 09:15 hour midpoint, PDH / PDL / PDC |
| Mathi Second Hour (Hourly Breakout) | CALL level = 10:15–11:15 high, PUT level = its low | PDH / PDL / PDC |
| Mathi Breakout – 9:15 | 09:15 1-minute candle high / low | Open, PDH / PDL / PDC |
| Mathi 13:15 Minute | 13:15 1-minute candle high / low | PDH / PDL / PDC |
| Mathi Trend Channel | Channel upper and lower lines (sloped, 3-minute swings) | PDH / PDL / PDC |

**When a strategy is on, it asks for:**
- **Current day:** a date, or Auto (the latest session, or the replayed day in replay).
- **Previous day:** a date before the current day, or Auto (the session before it).

**Per line:** show / hide, name, colour, thickness, style (solid / dashed / dotted), show name, show price, and extension (right, session only, or across the chart).

Settings save to the user's account automatically.

**Not listed:** the H0–H4 Fib, 1-Hour Fib Breakout and ATM CE+PE hedge strategies. Their levels come from option premiums, not the index.

## Architecture

| Layer | File |
|---|---|
| Strategy catalogue, config, validation, level calculation, overlay builder (pure, tested) | `src/lib/chart/line-drawings.ts` |
| Persistence (per user, one row per strategy) | `prisma/schema.prisma` → `ChartLineDrawing` |
| Server functions (ownership, limits) | `src/server/chart-lines.ts` |
| API | `GET/POST /api/chart-lines`; `GET /api/market/levels?symbol&date&previous&tape=1` |
| Client state | `src/components/line-draw/use-line-drawings.ts`, `use-line-days.ts` |
| Panel UI | `src/components/line-draw/line-draw-panel.tsx` |
| Chart wiring | `src/components/chart-desk.tsx` |
| Rendering | the existing `DrawingLayer` (overlays prefixed `lines:` are read-only and never take the pointer) |

**How it fits the existing code:**
- **Levels:** come from the same helpers the strategies use:
  - `getS1Data` / `s1Levels` for the previous day, open, 09:15 candle and boxes.
  - `hourlyCandles` for the hours.
  - `channelSignal` for the channel.
  - The day's 1-minute candles come from the replay loader (`getReplay`); today's copy is cached for one minute.
- **Requests:** strategies on the same days share one request. Live days refresh every minute.
- **Timing:** nothing is drawn before it existed:
  - Hours appear only once complete.
  - The 13:15 candle appears once closed.
  - In replay, everything follows the replay clock.
- **Rendering:** lines are read-only overlay drawings with stable ids (`lines:<row>:<line>`). Switching one strategy changes only its own objects.
- **Duplicates:** lines at the same price with the same style merge into one line whose label lists every name.

**Rows saved before this version** (free-form drawings, which have no strategy) are kept in the database but not shown.

## Limits

| Limit | Value |
|---|---|
| Lines per strategy | 24 |
| Line name | 40 characters |
| Where lines show | Stock and index charts only, not option contracts |
