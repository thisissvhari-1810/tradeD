-- The Strategy Algo's dedicated practice wallet (additive). Existing DEMO / LIVE wallets, the options-desk
-- paper account, orders and history are untouched; the ALGO wallet is opened with ₹1,00,000 on first use.
ALTER TYPE "PracticeMode" ADD VALUE IF NOT EXISTS 'ALGO';

-- Runs started before this migration keep their orders on the DEMO wallet until they end.
ALTER TABLE "AlgoRun" ADD COLUMN "wallet" "PracticeMode" NOT NULL DEFAULT 'DEMO';
