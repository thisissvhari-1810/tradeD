# Automatic market-data token renewal

The charts' Dhan token (Admin → Market data connection) is renewed automatically, the same way Neural Core's copy engine renews its accounts. Paste the client id and token once; after that, nobody needs to paste it daily.

## How it works

Dhan tokens last 24 hours. While a token is still active, `GET https://api.dhan.co/v2/RenewToken` swaps it for a new 24-hour token, and the old token stops working at once.

| Piece | File |
|---|---|
| When to renew (pure, tested) | `src/lib/dhan/token-renewal.ts` |
| Renew and save | `src/server/market-token-renewal.ts` |
| Endpoint for the scheduler | `src/app/api/market/token-renewal/route.ts` (needs `CRON_SECRET`, like `/api/algo/cron`) |
| Scheduler (every 5 min, all day) | `exec-worker/install-token-renewal.sh` |
| Status | Admin page → "Automatic renewal" |
| Tests | `tests/dhan-token-renewal.test.ts` |

## Schedule (IST)

| When | What happens |
|---|---|
| **15:40** | Renew, so the token covers the next session |
| **About 16:00** | Renew once more, so the token lasts until 16:00 the next day and the daily time never drifts |
| **07:30–09:00** | Second chance if the evening renewal didn't happen (for example, the worker was off) |
| **Market hours (09:00–15:35)** | Never, unless the token would otherwise expire before the close |

**Other rules:**
- **Retry:** at most one attempt per 10 minutes.
- **Unreadable answer:** if Dhan's answer has no newer token, that token is never sent again, and the Admin page asks for a new paste.
- **Manual paste wins:** a token pasted on the Admin page while a renewal is in flight is never overwritten.

## Setup (one time)

1. **Set `CRON_SECRET`:** make sure it's in the app's environment (it already is if the paper monitor is installed).
2. **Install the scheduler:** on the execution-worker server, run `sudo bash exec-worker/install-token-renewal.sh`. It reuses `/etc/traded-monitor.env`, or asks for the app URL and secret.
3. **Paste a fresh token:** paste a fresh token on the Admin page once (or keep the saved one, if it's still valid).
4. **Check the scheduler:** check that it runs with `journalctl -u traded-token-renewal.service -n 20`. The Admin page shows the last check and the last renewal.

**If the token has already expired,** Dhan can't renew it. Paste a new one; renewal continues from there.
