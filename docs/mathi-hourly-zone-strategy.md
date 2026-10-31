# Mathi Hourly Zone Strategy — 5%

A separate strategy (`MATHI_HOURLY`) with its own engine, settings, live paper session, state, order keys (run `MH`) and
trade history. Mathi Strategy, Mathi 5% and Mathi Bank Strategy are unchanged: they keep `engine: "existing"`, and
every runner path added for this strategy is behind `config.engine === "hourly"`.

## Where it lives

| Part | File |
|---|---|
| Rules (pure, unit-tested): hourly candles, colour → direction, LONG / SHORT zone, skip rule, pair schedule, midpoint rule | `src/lib/algo/hourly-zone.ts` |
| Engine hook-up: signal coordinator, midpoint exit, session-loss limit, trade record for the chart | `src/lib/algo/runner.ts` (`hourlyCoordinate`, `hourlyMidpointExit`, `trackHourly`, `lossLimit`, `MATHI_HOURLY_DEFAULTS`) |
| Settings reading and validation | `src/lib/algo/config.ts` (`hourlyOf`, the `engine === "hourly"` checks) |
| Live paper, chart replay, scheduler, settings save, view | `src/server/algo.ts` (`VARIANTS.MATHI_HOURLY`) |
| Storage | `AlgoSession.mathiHourlyConfig`, `AlgoSession.mathiHourlyState` (migration `20261028230000_algo_mathi_hourly`) |
| Panel (rules, warning, today's pairs, open trade with unrealized P&L and max adverse move, settings) | `src/components/algo/algo-hourly.tsx` |
| Chart (reference zone, status, midpoints) | `src/components/algo/algo-drawings.ts` (`hourlyDrawings`); `drawing-layer.tsx` draws an `algo:` position zone with its own label |
| Tests | `tests/mathi-hourly.test.ts` |

Execution is the shared runner's: ATM strike from the NIFTY close at the decision minute, nearest weekly expiry, the
real option premium, capital sizing in whole exchange lots (the contract's own lot size), charges and slippage,
idempotent order keys, reconciliation, the Algo wallet.

## Hourly candles

Built from completed 1-minute NIFTY candles on the 09:15 IST grid: 09:15–10:15, 10:15–11:15, …, 14:15–15:15. The
15:15–15:30 remainder is never a full hour and never part of a pair. A provider's own hourly bars are not used, so a
10:00 / 11:00 boundary cannot creep in. An hour is complete once its end has passed and its last minute (e.g. 11:14) has
closed; a live feed missing that minute is read without it after 120 seconds.

## The pair (default rules, 29 Oct 2026)

1. **Position tool** from the drawn (first) candle's colour (`directionFrom: "position"`): red → Long position, green →
   Short position; a doji drawn candle is skipped.
2. **Mid** = the drawn candle's close (`referencePrice: "close"`), for both colours (a red candle's body bottom, a green
   candle's body top). Fixed, never recomputed. `bodyLow` and `open` are available.
3. **Trade** from the second candle's close against the mid and the tool:

   | Position | 2nd candle closes above the mid | 2nd candle closes below the mid |
   |---|---|---|
   | Long (red drawn) | CALL | PUT |
   | Short (green drawn) | PUT | CALL |

   Exactly on the mid → no trade. Options are only ever bought.
4. **Body rule** (`skipPart: "body"`): the second candle's body must not cross the mid (checked on the side it closed).
5. **No box check** (`boxMode: "off"`): the second candle's wicks are not checked. The candle-wick box (`boxMode:
   "wick"` — Long from the drawn candle's low, Short from its high) is available.
6. **Daily trade** (`dailyFallback`, `fallbackTime "13:15"`): when no pair has passed by 13:15, the 13:15 pair (drawn
   11:15, second 12:15) is traded on its direction alone, its failed checks logged. One trade a session, so a trade
   taken at 11:15 or 12:15 is the day's trade.
7. Optional, off: the 1-point difference rule (`gapPoints`, the body edge nearest the mid), rejection / loss-side wick,
   strong body, opposite trade on a failed pair. All lowered accuracy in the 12-month backtest.

Pairs slide one hour (`pairStep: "sliding"`): decisions at 11:15, 12:15 and 13:15. Every pair is decided once, on the
minute that completes its second hour; skipped pairs are logged as REJECTED with every reason and both candles' OHLC.

Example, 27 Oct 2025: the 09:15 candle is green (Short position), mid 25,961.85 (its close); the 10:15 candle closes at
25,976.30, above it, with its body above it → PUT at 11:15.

## Entry

At the decision minute (earliest 11:15; `entryStart` cannot be set earlier): the ATM CE / PE of the nearest expiry at the
real premium plus slippage, whole lots from the capital (₹1,00,000 a session; at most 50 lots). The NIFTY reference
(`setup.level`) and NIFTY close (`setup.underlyingEntry`) are stored apart from the option entry premium.
`maxTrades` defaults to 1 a session; one position at a time; the order key (session, minute, side) and the stored last
candle make a repeated check, reconnect or rerender unable to place it twice. The last entry is 14:15 (`entryCutoff`):
the 13:15 + 14:15 pair, decided at 15:15, is not traded.

## Exits

- **Target**: `entry premium × 1.05` (rounded to the paisa), a resting sell checked on every option minute. In replay a
  touch fills at the target; in live paper the option's minute candles must trade one tick through it, or the bid must
  reach it.
- **Hourly midpoint** (NIFTY, completed hours only, from the first full hour after the entry): midpoint =
  (high + low) / 2. A LONG is kept only while the hour closes **above** it; a SHORT only while it closes **below** it; a
  close at the midpoint exits either. The exit sells at the premium at the hour's close.
- **Same hour**: the target is checked minute by minute and the midpoint only after the hour has closed, so a target
  touched inside an hour always comes first in time — no assumption about intrabar order is needed.
- **No stop-loss order** is ever created (`stopLoss: false`, stop level 0). The midpoint rule is not converted into
  one: it acts only on a completed hour.
- **Session-loss limit** (`maxSessionLoss`, ₹, default 0 = off): once realized losses reach it, no new entries.
- **End of day**: square-off at 15:20 IST; never carried overnight.

## Assumptions to confirm

1. The zone is the profit side of the reference with no width (defaults `zoneMinPoints 0`, `zoneMaxPoints 0`).
2. Only the second candle's **close** decides (confirmed); the wick / body rule is off.
3. After a skipped pair, the next pair is the **next two hours** (not a sliding hour).
4. **One trade** a session; after an exit no new entry (raise `maxTrades` to allow the next pair).
5. Last entry 14:15; square-off at 15:20.
