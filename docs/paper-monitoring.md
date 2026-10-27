# Paper-trading monitoring

How live paper positions (Mathi Strategy, Mathi 5%) are checked for their target and exits, with or without the app open.

## What runs where
- **Checks are server-side.** `GET /api/algo/cron` (`tickAllSessions` → `runScheduledChecks` in `src/lib/algo/monitor.ts`) checks every session that is running, holds a position or waits on an order. Each check takes the session's lease, reads the session again under it, runs the engine and saves. A second caller (another scheduler pass or the browser) waits for the lease or is reported busy; it never works on an old copy of the session, and exit orders are idempotent (`<entry>:exit:<n>` keys, unique per paper account).
- **The browser is only an extra trigger.** The Algo panel still asks for a check every 15 s while it is visible. Nothing depends on it.
- **A scheduler must call the route.** Vercel functions do not stay alive between requests, so something has to call the route on a schedule. Pick one:
  1. **Execution-worker server (recommended, every 30 s):** `sudo bash exec-worker/install-monitor.sh` on the worker host installs a systemd timer (09:10–15:35 IST, Monday–Friday).
  2. **External scheduler (free, every minute):** for example cron-job.org, `GET https://<app>/api/algo/cron` with header `Authorization: Bearer <CRON_SECRET>`.
  3. **Vercel Cron (Pro plan only):** add `{"crons":[{"path":"/api/algo/cron","schedule":"* * * * *"}]}` to `vercel.json`. Do not add it on Hobby: per-minute crons fail the deployment there.
- `CRON_SECRET` (16+ characters) must be set in the app's environment; without it the route refuses every call.

## How a target is detected
- Each check reads the option's quote (option-chain snapshot, bid / ask, at most 20 s cached and `maxQuoteAgeSeconds` old) **and** the option's own completed 1-minute candles for today.
- Candles since the last check are examined in time order, so a target reached between two checks is not missed. The target is treated as a **resting limit order**: it counts as filled when the option traded **at least one tick above** it (a trade above a sell limit means that limit was filled first; a touch alone does not prove a fill). The fill is booked at the target less the configured slippage, at the minute it happened.
- The entry minute is not used (its high may come from before the fill); the forming minute is left to the live quote.
- If a stop-loss is configured and one candle reaches both stop and target, the order inside the minute is unknown: the stop is taken and the note says so.
- A quote older than one already used is ignored. With neither a fresh quote nor new candles, nothing is decided; the check is logged as a data problem.

## Limits of the data
- Dhan's REST data has no tick history: between checks the resolution is one minute (open, high, low, close). A target that traded above the limit inside a minute is seen; the exact second is not. Bid / ask history does not exist; only the live snapshot has bid / ask.
- True tick-level monitoring needs a persistent market-feed (WebSocket) process; this design does not need one, because the candles cover the gaps between checks.

## Status in the app
The Mathi status card shows the last check (time, and server scheduler or browser), the quote and candles used, the target against the best price seen, and a warning when market data is missing or no check has run for 3+ minutes with a position open. The cron route's answer lists every session checked and any problem, so the scheduler's own log shows failures.
