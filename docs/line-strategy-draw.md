# Line Strategy Draw

**Strategy** controls what the trading system runs. **Line Strategy Draw** controls which saved strategy lines and price levels appear on the chart. They are separate features. Line Strategy Draw never turns a strategy or algo on or off, and never changes how levels are calculated.

## What users can do

- **Save many named drawings.** Each has an instrument (one symbol or all symbols), a timeframe (one or all), and a list of lines.
- **Line levels available:**
  - Previous-day high, low, close and midpoint.
  - Today's open.
  - The 09:15 candle's high and low.
  - The Strategy (S1) box A and box B top, mid and bottom.
  - Custom prices.
- **Per line:** colour, thickness, style (solid / dashed / dotted), show name, show price, and extension (right, session only, or across the chart).
- **Manage drawings:**
  - Create from a template (Custom, Previous Day Levels, Opening Levels, Mathi Strategy Lines).
  - Edit, rename (in the editor), duplicate, and delete (with confirmation).
  - Each drawing has its own visibility switch; there are also Show all and Hide all.
  - Edits preview on the chart until Save or Cancel.

## Architecture

| Layer | File |
|---|---|
| Config shape, validation, level catalogue, overlay builder (pure, tested) | `src/lib/chart/line-drawings.ts` |
| Persistence (per user, database) | `prisma/schema.prisma` → `ChartLineDrawing`; migration `20261122120000_chart_line_drawings` |
| Server functions (ownership, limits) | `src/server/chart-lines.ts` |
| API | `GET/POST /api/chart-lines`, `GET /api/market/levels` |
| Client state | `src/components/line-draw/use-line-drawings.ts` |
| Panel UI | `src/components/line-draw/line-draw-panel.tsx` |
| Chart wiring | `src/components/chart-desk.tsx` (button, panel, levels fetch, overlay merge) |
| Rendering | the existing `DrawingLayer` (overlays prefixed `lines:` are read-only and never take the pointer) |

**How it fits the existing code:**
- **Levels:** come from the same `getS1Data` / `s1Levels` the Strategy uses, through a separate read-only endpoint. The Strategy and its `/api/market/s1` endpoint are unchanged.
- **Rendering:** lines are read-only overlay drawings with stable ids (`lines:<drawing>:<line>`). Toggling or editing one drawing only changes its own objects; the chart, zoom and scroll are never rebuilt.
- **Duplicates:** lines at the same price with the same style are merged into one line whose label lists every name.
- **Replay:** the open and 09:15 levels appear only once the replay clock reaches them.

## Limits

| Limit | Value |
|---|---|
| Drawings per user | 50 |
| Lines per drawing | 24 |
| Drawing name | 60 characters |
| Line name | 40 characters |
| Where lines show | Stock and index charts only, not option contracts |
