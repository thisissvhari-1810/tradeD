# Mathi Trend Channel

A separate strategy (`MATHI_CHANNEL`) with its own engine (`engine: "channel"`), settings, live paper session, state,
order keys (run `MC`), events and trade history. Mathi Strategy and Mathi Hourly Zone Strategy are unchanged: every
runner path added for it is behind `config.engine === "channel"`.

## Where it lives

| Part | File |
|---|---|
| Rules (pure, unit-tested): 3-minute candles, C1, deep swings, first combination, primary line + clone, horizontal zones, breakout / WATCH / next-candle confirmation | `src/lib/algo/trend-channel.ts` |
| Engine hook-up: signal coordinator, defaults | `src/lib/algo/runner.ts` (`channelCoordinate`, `MATHI_CHANNEL_DEFAULTS`) |
| Settings reading and validation | `src/lib/algo/config.ts` (`channelOf`, the `engine === "channel"` checks) |
| Live paper, chart replay, scheduler, settings save, view | `src/server/algo.ts` (`VARIANTS.MATHI_CHANNEL`) |
| Storage | `AlgoSession.mathiChannelConfig`, `AlgoSession.mathiChannelState` (migration `20261031180000_algo_mathi_channel`, additive) |
| Panel (live information panel, rules, settings) | `src/components/algo/algo-channel.tsx` |
| Chart (primary line, dashed clone, swing labels, zones with axis prices, breakout / confirmation markers) | `src/components/algo/algo-drawings.ts` (`channelDrawings`, `channelMarkers`) |
| Tests | `tests/mathi-channel.test.ts` |
| Real-premium backtest | `scripts/backtest-mathi-channel.ts` |

## Rules

1. **3-minute candles** from completed 1-minute NIFTY candles on the 09:15 grid. A candle is complete when its last
   minute has closed (or, that minute missing, the next one has).
2. **C1** (09:15–09:18) is never a swing, never a comparison candle for a swing and never traded on.
3. **Deep swings** — the chart trendline engine's method (`findSwings`): a high not exceeded by `left` (3) candles before
   and `right` (3) after; lows mirrored. It is confirmed when the third later candle closes. It is kept only if it is at
   least `minSwingAtr` (1) × the average range of the session's candles (as known at its confirmation) away from the
   previous opposite swing **in its own direction** (a low below the high before it, a high above the low). Two of
   a kind in a row keep the more extreme. (The chart engine measures the move without direction; with that, a "low"
   could sit above the previous high and the clone would land on the wrong side.)
4. **First valid combination**: the first three kept swings — H1 → L1 → H2 (Pattern A) or L1 → H1 → L2 (Pattern B),
   whichever completes first. It is locked for the session and never replaced by later swings.
5. **Channel**: the primary line through the two same-kind swings, `price = intercept + slope × x` (x in 3-minute
   candles from 09:15). The clone is built from the primary's own `slope` value and only gets a new intercept through
   the third swing (`channelLines`). Both are extended forward.
6. **Horizontal zones**: every kept swing high (resistance) and low (support), plus the pattern's points; levels within
   `zonePercent` (0.05%) merge into one zone. A zone is broken by the first close beyond it after its latest swing was
   confirmed. The **relevant** level is the nearest unbroken one (resistance above for a CALL, support below for a PUT);
   with none left, the furthest broken one.
7. **Breakout** (completed candle after the channel exists): close above the upper line **and** above the relevant
   resistance → bullish; close below the lower line and below support → bearish. Its high and low are recorded. Beyond
   the line only → **WATCH**, never an entry. A new breakout needs the previous candle not to have been one.
8. **Confirmation** on the very next 3-minute candle: CALL — its high above the breakout high and its close above the
   broken resistance; PUT — its low below the breakout low and its close below the broken support. Otherwise the setup
   is skipped (logged as REJECTED with both candles' prices). No later candle is waited for.
9. **Loss-avoiding rules** (31 Oct 2026; a confirmed setup that fails one is skipped and logged, a later setup may trade):
   the breakout candle's body at least `minBreakoutBody` (75)% of its range, and NIFTY at least `minMomentumPercent`
   (0.11)% in the trade's direction over the last 5 three-minute candles at the confirming close. Chosen on 2022–24,
   checked on 2024–26: 4 years 526 trades 427 / 99 (81.2%) against 884 · 653 / 231 without them.
10. **Entry** at the confirming candle's close: ATM CALL / PUT, nearest weekly expiry.
11. **A trade every day** (`fallback: "daymove"`, `fallbackTime: "11:00"`, 1 Nov 2026): when nothing has traded by 11:00,
    NIFTY at 11:00 against the 09:15 open decides — above: ATM CALL, below: ATM PUT. A setup traded earlier takes the
    day's one trade. No time limit: held to +5% or 15:20. 4 years: 862 / 122 (87.6%), a net loss. Other options:
    `fallback: "channel"`, other times, the retest, the opening-gap rule (all settings, off / not default).

Settings (saved apart from other strategies): `left`, `right`, `minSwingAtr`, `zonePercent`, `requireLevel` (false =
channel-only breakouts, for research), `patterns` (`both` / `A` / `B`), `minBreakoutBody`, `minMomentumPercent`, `maxTrades`.

## Execution and exits

**+3% target on the executed option premium** (1 Nov 2026; +5% before), **no stop-loss order**. The rest is
Mathi Strategy's, unchanged — the shared runner: capital sizing in whole lots from ₹1,00,000, the real premium plus 1
tick slippage, statutory charges on both legs, idempotent order keys, **1 trade a session** (31 Oct 2026), the 45-minute trend
checkpoint (held up to 90 minutes while the NIFTY trend agrees), one position at a time, the 15:20
square-off. Only these differ from Mathi Strategy's defaults: no regime switch, no forming-candle entries, and the
confirmation is the channel's own (not the line retest).

## No look-ahead

Everything is a pure function of the completed candles up to the decision minute. Swings are used only from their
confirmation; the deep-swing cutoff uses the average range known then; zones' breaks are checked up to the candle
before; the signal fires only on the minute its confirming candle completes. The tests replay 25 random sessions
minute by minute and check that every swing, the combination and every setup are identical to what the full session
later shows.
