-- Algo replay sessions: their own practice period and an archived summary (additive).
ALTER TABLE "AlgoRun" ADD COLUMN "periodId" TEXT;
ALTER TABLE "AlgoRun" ADD COLUMN "summary" JSONB;
