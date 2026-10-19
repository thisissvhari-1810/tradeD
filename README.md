# TradeD

TradeD is a separate trading terminal with its own PostgreSQL database. It started from the TradeM codebase but no longer shares TradeM's database, users or Dhan token.

Practice orders stay on the virtual ledger. TradeD can read Dhan funds, positions, holdings, and orders when `DHAN_CLIENT_ID` and a valid access token are configured. It does not submit orders to the exchange.

## Setup

1. Use Node.js 22 or newer.
2. Copy `.env.example` to `.env.local`.
3. Point `DATABASE_URL` and `DATABASE_URL_UNPOOLED` at TradeD's own database. TradeD owns its migrations in `prisma/migrations`; `npm run build` applies them (`prisma migrate deploy`) and then runs `scripts/db-setup.ts`, which seeds the NSE instrument catalogue and default settings into an empty database.
4. First sign-in: set `BOOTSTRAP_ADMIN_PASSWORD` (and `BOOTSTRAP_ADMIN_EMAIL`, or rely on `DHAN_ACCOUNT_OWNER_EMAIL`) and build once. The build creates that admin only while no admin exists. Remove the password from the environment afterwards.
5. Set `MARKET_DATA_PROVIDER` (`demo`, `dhan`, `twelvedata`, or `alphavantage`). Keep provider keys and the Dhan token on the server. The Dhan access token itself is read from the `market.dhanAccessToken` setting or, if that is absent, from `MARKET_DATA_API_KEY`.
6. Install and start:

```bash
npm install
npm run dev
```

Sign in with the bootstrapped admin. Paste the daily Dhan access token in Admin → Market data.

## Scripts

- `npm run dev` starts the terminal.
- `npm test` runs the engine tests copied with TradeD plus the Supertrend check.
- `npm run build` generates the Prisma client, applies migrations, seeds an empty database and builds Next.js.
- `npm run db:deploy` / `npm run db:setup` run those two database steps on their own.

## Deployment

The Vercel project `traded` deploys this folder. Its Neon database is connected through the Vercel Neon integration, which provides `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `POSTGRES_PRISMA_URL`. Live orders go through the static-IP execution worker in `exec-worker/`; see that folder's `install.sh`.

## Environment names

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `MARKET_DATA_PROVIDER`, `MARKET_DATA_API_KEY`, `MARKET_DATA_MODE`, `DHAN_CLIENT_ID`, `NIFTY_DHAN_SECURITY_ID`, `APP_URL`.

Never commit `.env.local` or paste access tokens into the client.
