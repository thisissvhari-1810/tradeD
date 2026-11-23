# Automated multi-strategy paper trading

Eight backtested NIFTY option strategies run every trading day on the server, each with its own ₹20,000 wallet that starts fresh each day.

This is **paper only**: every fill is simulated on the live option quote, and nothing is sent to a broker. Only a Super Admin can open it, from **Auto Trading** in the sidebar.

## Strategies and where their rules come from

| Key | Strategy | Original backtest code (D:/TRADING) |
|---|---|---|
| SH_TUE_THU, SH_TUE, SH_THU, SH_ALL | Mathi Second Hour (Tue+Thu / Tue / Thu / all days) | `PROJECT_NEXUS/MATHI_SECOND_HOUR*` |
| MHB_FINAL | Mathi Hourly Breakout FINAL | The Second Hour script with `--one-trade --no-gapdown --no-wedmom` |
| M1315_V3, M1315_V2 | Mathi 13:15 Minute v3 / v2 | `PROJECT_NEXUS/MATHI_1315_MINUTE/FIXED_v3…`, `FIXED_v2…` |
| MONWED | MonWed (frozen rules, fixed +1.48%) | `NIFTY_HOURLY_ATM_CE_2PT/monwed.py` (`--exit=fixed`) |

**Where the code lives:**
- **Entry rules:** `src/lib/auto/rules.ts`, ported one-to-one.
- **Exits and sizing:** `src/lib/auto/exits.ts`.

**Parity check (24 Nov 2026):** the port was run on 5 years of the research data. It matched every research trade on entry minute, strike, CE/PE, buy price, exit minute and exit price:

| Strategy | Trades matched |
|---|---|
| Second Hour (all days) | 520 / 520 |
| Second Hour Tue+Thu | 214 / 214 |
| Second Hour Tuesday | 103 / 103 |
| Second Hour Thursday | 111 / 111 |
| Hourly Breakout FINAL | 320 / 320 |
| 13:15 Minute v3 | 274 / 274 |
| 13:15 Minute v2 | 240 / 240 |
| MonWed | 244 / 244 |

The remaining differences are known:
- **Expiry-day trade 2 (11 trades):** the research data was missing the same-day contract on 25 of 110 expiry days, so it traded next week's option. The port follows the stated rule: nearest weekly, and no trade 2 on expiry day.
- **13:15 Minute extra days:** the research only evaluated about 1,226 days. Live trading evaluates every day.

## How it runs

1. **Scheduler:** a systemd timer on the Neural Core server (`exec-worker/install-auto-engine.sh`) calls `GET /api/auto/cron` every 30 s, 09:00–15:50 IST on weekdays. The route needs `AUTO_CRON_SECRET`.
2. **One pass:** `autoTick` in `src/server/auto/engine.ts`.
   - **Lease:** a database lease means two passes never overlap.
   - **Wallets:** the day's wallets are created, one per strategy per date.
   - **Market data:** NIFTY's completed 1-minute candles, India VIX (when a rule needs it), the option chain and the open contracts' candles are read once.
   - **Strategies:** the 8 strategies then run independently.
3. **Entry:** the strategy's own rule fires on completed candles only. The buy is at the live **ask + ₹0.05 slippage**, sized in whole lots from the wallet (trade 2 uses the day's balance, capped at ₹20,000). A signal is **SKIPPED** with its reason when:
   - it is seen more than 180 s after its candle closed;
   - no fresh quote arrives in time;
   - one lot costs more than the wallet;
   - the 13:15 trade-2 option costs ₹85 or more.
4. **Exit:** the backtest's exit, run on the option's completed 1-minute candles:
   - **Trail strategies:** the trail starts at the lower of +2% and +₹2 on the premium. The stop is the highest price minus 1% of the buy price, never below the start.
   - **Trade-2 lock:** +0.5% for Second Hour, +0.7% for 13:15 Minute.
   - **MonWed:** a +1.48% limit.
   - **Time exit:** 15:20 for all strategies.

   The sell is at the live **bid − ₹0.05**. With no fresh bid for 2 minutes, it sells at the last traded price, and the trade notes say so.
5. **Day close:** after 15:35 the day is closed and the report is frozen. Reports are on **Auto Trading → Daily reports**, with a CSV export.

## Controls

| Control | Effect |
|---|---|
| **Master OFF** | No new entries anywhere. Open positions are still managed to their exit. |
| **Disable / Pause** (one strategy) | No new entries for that strategy only. |
| **Mode SHADOW** | Signals and would-be prices are recorded; no wallet changes. |
| **MonWed event days** | RBI, FOMC, Budget, elections and tariffs, stored in AppSetting `auto.monwed.events`. |

**MonWed event dates:**
- Defaults come from `monwed.py`, plus the published 2026–27 RBI and FOMC dates.
- **Review the list:** the 9 Dec 2026 FOMC date and future election dates need checking.
- **To change it:** `POST /api/auto {action:"events"}`.

## Data model

All tables are new (migration `20261124090000_auto_paper_trading`); money is in paise.

| Table | Holds |
|---|---|
| `AutoEngine` | Master switch, mode, lease, heartbeat |
| `AutoStrategy` | Switches and worker status |
| `AutoDay` | Daily wallet and totals |
| `AutoSignal` | Every signal: traded, skipped or shadow |
| `AutoTrade` | Positions and closed trades |
| `AutoOrder` | Fills, with a unique idempotency key |
| `AutoSnapshot` | Price marks of open positions |
| `AutoEvent` | Execution log, system events, data health |
| `AutoReport` | Frozen daily reports |

## Tests

| File | What it checks |
|---|---|
| `tests/auto-rules.test.ts` | The trailing formula and lock, the +1.48% target, ₹20k sizing, the app's charges, time limits, no look-ahead, SENSEX expiry and the event calendar |
| `tests/auto-engine.test.ts` | Full simulated sessions on real NIFTY candles through the real engine, with an in-memory database (below) |

What `tests/auto-engine.test.ts` covers:
- **A no-trade day:** 19 Nov 2026.
- **A Second Hour day:** 6 Aug 2026. Trade 1 equals the backtest's 11:19 24650 CE, and wallets and P&L reconcile.
- **A MonWed day:** 2 Nov 2026.
- **Overlapping passes:** never fill twice.
- **Next-day reset:** wallets go back to ₹20,000.
- **Pause and Master OFF.**
- **Holidays and weekends.**
- **A chain outage:** a late signal is skipped and never bought late.
