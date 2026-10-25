-- Algo - Primary Strategy: its own settings, the exclusive execution lock and run attribution (additive).
ALTER TABLE "AlgoSession" ADD COLUMN "activeStrategy" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "AlgoSession" ADD COLUMN "primaryConfig" JSONB;
ALTER TABLE "AlgoRun" ADD COLUMN "strategy" TEXT NOT NULL DEFAULT 'EXISTING_ALGO';
