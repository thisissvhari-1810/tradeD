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
| Mathi Trend Channel | 1-minute channel (upper / lower), 1st High, 1st Low, 2nd High or 2nd Low | PDH / PDL / PDC |

**When a strategy is on, it asks for:**
- **Current day:** a date, or Auto (the latest session, or the replayed day in replay).
- **Previous day:** a date before the current day, or Auto (the session before it).

**Entry point:** when a strategy is on, the chart marks where it buys (trade 1) on the chosen day: ▲ under the candle for an ATM CALL (CE), ▼ above it for an ATM PUT (PE). Hovering the marker shows the strategy, the time and NIFTY's price. The panel's Entry point section shows the same, or why there was no trade (for example "first-hour range ≥ 108.8"). The marker can be switched off per strategy. Logic: `src/lib/chart/line-entries.ts`.

| Strategy | Entry rule used |
|---|---|
| Hourly Zone 5% | The app's own `hourlySignal` (default settings), run minute by minute like the algo runner |
| Trend Channel | The 1-minute channel below (`src/lib/chart/trendlines.ts`) |
| Second Hour, 13:15 Minute, Breakout 9:15 | The research rules (PROJECT_NEXUS), ported one-to-one; 13:15 uses India VIX's 1-minute candles |
| Mathi Strategy | Not marked. Its entries depend on its option-premium exits and the regime filter, so the Algo's own trade markers show them |

**Checked on 5 years of real NIFTY data (23 Nov 2026):** trade 1 matched the research / app backtest on every traded day:

| Strategy | Matched |
|---|---|
| Breakout 9:15 | 1,135 / 1,135 |
| Second Hour | 404 / 404 |
| 13:15 Minute (without VIX) | 193 / 193 |
| Trend Channel (the Algo's 3-minute channel; the panel's 1-minute trend lines have no backtest) | 1,229 / 1,229 |

**Mathi Trend Channel (as the user draws it; checked on 19 and 23 Nov 2026).** It reads the chart's own candles: 1m, 3m, 5m, 15m, 30m, 1h, 2h or 4h (daily and longer charts use 1-minute). Every count below is in those candles. On candles bigger than 5 minutes there is no 11:00 rule; breakouts are watched until 15:00.

**Patterns:**
- **2 highs + 1 low:** 1st High → 1st Low → 2nd High. The primary line goes through the two highs and its parallel copy through the low (23 Nov: 25,979.65 → 25,567.30 → 25,716.80).
- **2 lows + 1 high:** 1st Low → 1st High → 2nd Low. The primary line goes through the two lows and its parallel copy through the high (19 Nov: 25,186.70 → 25,255.60 → 25,139.30).

**How the three points are found:**
- **1st and 2nd points:** the high and low of 09:15–09:17, in the order they happened. The 09:15 candle counts by its body; its opening wick is ignored.
- **The later of the two** keeps moving while price goes that way. It is fixed once 3 candles haven't gone beyond it.
- **3rd point:** the next swing the other way. It is fixed after 3 quiet candles, and only if it moved at least 2 × the average 1-minute range.

**Trading:**
- **Breakout:** a close beyond a channel line.
- **Entry:** the next candle goes past the breakout candle's high (CALL) or low (PUT) and closes beyond the line.
- **No entry by 11:00:** the 11:00 day-direction rule applies.

**Scope:**
- **Lines** show only once each point is fixed.
- **The Algo's own Trend Channel** (3-minute) is unchanged.

**Only trade 1 is marked.** A second trade depends on when trade 1 exits on the option.

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
