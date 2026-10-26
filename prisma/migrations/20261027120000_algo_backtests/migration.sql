-- Saved Algo backtests (additive): settings, costs, coverage, warnings and every day's result and trades.
CREATE TABLE "AlgoBacktest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "strategyVersion" INTEGER NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "capital" DOUBLE PRECISION NOT NULL,
    "mode" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "costs" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "days" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlgoBacktest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AlgoBacktest_sessionId_createdAt_idx" ON "AlgoBacktest"("sessionId", "createdAt");
ALTER TABLE "AlgoBacktest" ADD CONSTRAINT "AlgoBacktest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AlgoSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
