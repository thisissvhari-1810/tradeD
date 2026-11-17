# H0–H4 Fibonacci Breakout (NIFTY ATM CE)

An independent TradeD strategy: NIFTY 50 weekly ATM **CE, BUY only**. Backtest and paper trading only. It has no live-order path (`liveOrders: false`), and nothing in it can send a broker order.

## Rules (current default, corrected by the user on 17 Nov 2026)

1. **Candles.** 1-minute (`candleMinutes: 1`). Levels are set only by completed candles.
2. **Opening candle.** The NIFTY 09:15 candle must be GREEN (close > open). RED or NEUTRAL skips the session.
3. **ATM.** That candle's close, rounded to the nearest 50 (half up). The ATM CE of the nearest weekly expiry is used all day.
4. **H0 and Initial Low.** H0 = HIGH of the CE's own 09:15 candle; Initial Low = its LOW.
5. **H1–H4 (`breakMode: "high"`).** H1 = HIGH of the first later candle whose **HIGH goes above** H0. The close does not matter. H2, H3 and H4 follow the same way. A level is never set and broken by the same candle.
6. **Fibonacci, locked after H3:**
   - 0.0 = Initial Low
   - 0.5 = H3
   - 0.618 = L + (H3 − L) × 1.236 (the target)

   The sell order is the target rounded up to the ₹0.05 tick.
7. **H4 check.** H4 must be strictly **below** Fib 0.618; equal or above skips the session.
8. **Entry (`entryMode: "touch"`).** A stop-buy one tick above H4, live from the candle after H4. It is skipped if Fib 0.618 has already traded, or if the price at entry is already at or above it.
   - **Backtest:** filled when a 1-minute bar trades through it, at that price + 2 ticks (at the open + 2 ticks if a bar opens above it). The target is then checked from the next bar.
   - **Paper:** the break is only known on the next tick, so the order fills at the live ask.
9. **Exit.** A resting SELL at Fib 0.618. No stop-loss and no trailing; a position still open at 15:29 is squared off.

**Worked example, 16 Nov 2026, 25300 CE:**
- Initial Low 85.00.
- Levels: H0 119.75 (09:15), H1 128.70 (09:16 candle, which closed 101.60), H2 129.15 (09:50), H3 130.00 (09:51), H4 132.50 (09:54).
- Fib 0.618 = 140.62.
- BUY at 09:55: stop 132.55 + 2 ticks = 132.65.

**Original spec (`H0H4_V1_CLOSE_5M`, backtest `--v1`):** 5-minute candles, a level breaks only on a CLOSE above it, and the BUY is at the next 1-minute open after a candle closes above H4. Research options:
- `--candle-minutes 1|3|5`
- `--break close|high`
- `--entry close|touch`
- `--target-pct`, `--target-points`
- `--open-colour green|both-ce|both-pe`
- `--breakout-target cancel|allow`

With ₹104 / ₹118 the 0.618 level is **₹121.304**; the illustration's ₹122.97 is not used.

## State machine

The phases are:
`WAITING_FOR_OPEN → CHECKING_GREEN → SELECTING_ATM → WAITING_FOR_H0 → WAITING_FOR_H1 → WAITING_FOR_H2 → WAITING_FOR_H3 → CALCULATING_FIB → WAITING_FOR_H4 → VALIDATING_H4 → WAITING_FOR_H4_BREAK → ENTRY_PENDING → POSITION_OPEN → EXIT_PENDING → TARGET_COMPLETED`, or `SESSION_SKIPPED` / `SESSION_COMPLETED`.

`advanceH0H4(state, feed)` (in `src/lib/algo/fib-h0h4.ts`) is pure and idempotent:
- It processes only 5-minute candles newer than `lastCandle`. Duplicate or out-of-order candles are ignored and counted, and duplicate 1-minute bars are merged.
- Its output depends only on the persisted state plus completed market data. Repeated ticks, WebSocket or API reconnects and restarts therefore never repeat a level, a signal or an order.
- `entry` is written exactly once, from `ENTRY_PENDING`.

On a live feed, a candle is complete once a later 1-minute bar exists, or 3 minutes after it ends. Missing data is never filled in. Every skipped or no-entry session records a reason code (`REASON_TEXT`).

## Files

| File | Role |
|---|---|
| `src/lib/algo/fib-h0h4.ts` | Engine: settings, 5-minute aggregation, state machine, fills, charges, report, NSE weekly-expiry rule. |
| `src/server/fib-h0h4.ts` | Paper runner, persistence, in-app range backtest, 5-year baseline reader, scheduler entry. |
| `src/app/api/fib-h0h4/route.ts` | `GET` returns the view, `?day=`, `?backtests=1` or `?baseline=1`. `POST` takes `start`, `stop`, `tick` or `backtest {from,to}`. |
| `src/app/api/fib-h0h4/cron/route.ts` | Server monitor. Same `CRON_SECRET` bearer check as `/api/algo/cron`. |
| `src/app/(desk)/fib-h0h4/page.tsx`, `src/components/fib-h0h4/*` | Dashboard (Paper / Backtest / History) and the Lightweight Charts v5 chart. |
| `scripts/backtest-fib-h0h4.ts` | Full-history backtest on the exported master data. Writes `.backtests/fib-h0h4/latest.json` for the app. |
| `tests/fib-h0h4.test.ts` | Spec tests 1–11 plus math, feed-safety and report tests. |

The only existing file touched is `src/components/shell.tsx`: one nav entry ("H0–H4 Fib").

**Persistence.** Everything is stored in `AppSetting` rows, so there is no schema migration:
- `fibH0H4:paper:<userId>`: on/off, today's state, the last 260 session rows and the last 30 full states.
- `fibH0H4:backtests:<userId>`: the last 10 runs.

Writes use optimistic locking on `updatedAt`, so two ticks at once cannot both act. A new IST date archives the old state and starts empty.

**Market data.** Existing services only:
- `sessionMinuteTape("NIFTY")` for the NIFTY spot tape
- `loadOptionChain("NIFTY")` for the nearest expiry, security id, lot size and bid/ask
- `dhanOptionSession` for the CE 1-minute tape
- `dhanExpiredOptions` (rolling ATM ± 10) for the in-app backtests

## Running

- **Paper:** open **H0–H4 Fib** and select **Start paper session**. The page refreshes every 15 seconds. For monitoring with the page closed, add `GET /api/fib-h0h4/cron` (header `Authorization: Bearer <CRON_SECRET>`) to the scheduler beside `/api/algo/cron`, every minute 09:15–15:35 IST (see `docs/paper-monitoring.md`).
- **5-year backtest:**
  ```
  python scripts/export-fib-breakout-data.py --from 2021-11-01 --to 2026-11-12 --expiry-rule --atm-only --atm-time 09:19 --out <folder>/data
  npx tsx scripts/backtest-fib-h0h4.ts --data <folder>/data
  ```
  Options: `--breakout-target cancel|allow`, `--slippage-ticks`, `--target-fill trade-through|touch`.

## Open-spec choices

- **Breakout candle's own high ≥ Fib 0.618** (its close above H4): skipped by default, because the target traded before a BUY was possible. The spec's ₹123-high example implies a BUY; that reading is `breakoutTargetCheck: "allow"`. Both are reported.
- **No exit after the target is missed.** The spec gives no rule for this. The position is squared off at 15:29 (intraday, as the other TradeD strategies do).
- **Target fill.** The target fills only when a traded 1-minute bar goes one tick through the sell price (not on a touch). Square-off is at the 15:29 open − 2 ticks.
- **Intrabar ambiguity cannot arise.** The entry is at a bar open and there is no stop, so no minute has two competing exits. The ambiguous count is 0 by construction.
- **Charges:** ₹20 per order plus dated statutory STT, NSE, SEBI, stamp duty and GST (shared with the 1-Hour Fib strategy).
