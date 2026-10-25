-- Algo runs inside the chart's historical replay (additive).
CREATE TABLE "AlgoRun" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "replaySession" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "armed" BOOLEAN NOT NULL DEFAULT false,
    "processedThrough" INTEGER NOT NULL,
    "startCashPaise" BIGINT NOT NULL,
    "endCashPaise" BIGINT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "AlgoRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlgoRun_sessionId_replaySession_key" ON "AlgoRun"("sessionId", "replaySession");
CREATE INDEX "AlgoRun_sessionId_startedAt_idx" ON "AlgoRun"("sessionId", "startedAt");

ALTER TABLE "AlgoRun" ADD CONSTRAINT "AlgoRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AlgoSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
