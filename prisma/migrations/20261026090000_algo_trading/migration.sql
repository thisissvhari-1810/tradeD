-- AlterTable
ALTER TABLE "OptionPaperOrder" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "OptionPaperPosition" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "AlgoSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlgoSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlgoEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "key" TEXT NOT NULL,
    "time" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlgoEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlgoSession_userId_key" ON "AlgoSession"("userId");

-- CreateIndex
CREATE INDEX "AlgoEvent_sessionId_mode_time_idx" ON "AlgoEvent"("sessionId", "mode", "time");

-- CreateIndex
CREATE UNIQUE INDEX "AlgoEvent_sessionId_runId_key_key" ON "AlgoEvent"("sessionId", "runId", "key");

-- AddForeignKey
ALTER TABLE "AlgoSession" ADD CONSTRAINT "AlgoSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlgoEvent" ADD CONSTRAINT "AlgoEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AlgoSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
