# TradeD

TradeD is a separate trading terminal. It uses the TradeM paper-trading ledger, instrument catalogue, and market-data adapters, including the server-side Dhan token saved in TradeM. It does not replace the TradeM deployment.

Practice orders stay on the virtual ledger. TradeD can read Dhan funds, positions, holdings, and orders when `DHAN_CLIENT_ID` and a valid access token are configured. It does not submit orders to the exchange.

## Setup

1. Use Node.js 22 or newer.
2. Copy `.env.example` to `.env.local`.
3. Point `DATABASE_URL` and `DATABASE_URL_UNPOOLED` at the same database TradeM already uses, or at a migrated copy of that schema. TradeD does not own database migrations. Apply migrations from the TradeM project.
4. Set `MARKET_DATA_PROVIDER` the same way TradeM does (`demo`, `dhan`, `twelvedata`, or `alphavantage`). Keep provider keys and the Dhan token on the server. The Dhan access token itself is read from the `market.dhanAccessToken` setting or, if that is absent, from `MARKET_DATA_API_KEY`.
5. Install and start:

```bash
npm install
npm run dev
```

Sign in with an existing TradeM user. Student accounts can place practice orders.

## Scripts

- `npm run dev` starts the terminal.
- `npm test` runs the engine tests copied with TradeD plus the Supertrend check.
- `npm run build` generates the Prisma client and builds Next.js.

## Deployment

Create a new Vercel project whose root is this folder. Do not point it at the existing TradeM project. Set the environment variables from `.env.example` in that project. Do not add TradeM's cron jobs here; resting practice orders are evaluated when the portfolio is loaded.

## Environment names

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `MARKET_DATA_PROVIDER`, `MARKET_DATA_API_KEY`, `MARKET_DATA_MODE`, `DHAN_CLIENT_ID`, `NIFTY_DHAN_SECURITY_ID`, `APP_URL`.

Never commit `.env.local` or paste access tokens into the client.
