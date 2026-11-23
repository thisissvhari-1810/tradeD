-- CreateTable
CREATE TABLE "AutoEngine" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mode" TEXT NOT NULL DEFAULT 'PAPER',
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "lastTick" JSONB,
    "config" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoEngine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoStrategy" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastSignal" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoStrategy_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AutoDay" (
    "id" TEXT NOT NULL,
    "strategyKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "openingPaise" INTEGER NOT NULL,
    "availablePaise" INTEGER NOT NULL,
    "investedPaise" INTEGER NOT NULL DEFAULT 0,
    "realizedPaise" INTEGER NOT NULL DEFAULT 0,
    "chargesPaise" INTEGER NOT NULL DEFAULT 0,
    "trades" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "note" TEXT NOT NULL DEFAULT '',
    "state" JSONB,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoSignal" (
    "id" TEXT NOT NULL,
    "strategyKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "tradeNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "right" TEXT NOT NULL,
    "strike" INTEGER NOT NULL,
    "breakoutMinute" INTEGER NOT NULL,
    "confirmMinute" INTEGER NOT NULL,
    "level" DOUBLE PRECISION NOT NULL,
    "nifty" DOUBLE PRECISION NOT NULL,
    "vix" DOUBLE PRECISION,
    "reason" TEXT NOT NULL DEFAULT '',
    "detail" JSONB,
    "signalAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTrade" (
    "id" TEXT NOT NULL,
    "strategyKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "tradeNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "right" TEXT NOT NULL,
    "strike" INTEGER NOT NULL,
    "expiry" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "lots" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "signalAt" TIMESTAMP(3) NOT NULL,
    "entryAt" TIMESTAMP(3) NOT NULL,
    "entryPaise" INTEGER NOT NULL,
    "entryBidPaise" INTEGER,
    "entryAskPaise" INTEGER,
    "entryChargesPaise" INTEGER NOT NULL,
    "investedPaise" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "targetPaise" INTEGER,
    "stopPaise" INTEGER,
    "lastPaise" INTEGER,
    "lastAt" TIMESTAMP(3),
    "unrealizedPaise" INTEGER,
    "exitAt" TIMESTAMP(3),
    "exitPaise" INTEGER,
    "exitBidPaise" INTEGER,
    "exitChargesPaise" INTEGER,
    "exitReason" TEXT,
    "exitModel" JSONB,
    "grossPaise" INTEGER,
    "netPaise" INTEGER,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoOrder" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "strategyKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "tradeId" TEXT,
    "side" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "pricePaise" INTEGER,
    "bidPaise" INTEGER,
    "askPaise" INTEGER,
    "quoteAt" TIMESTAMP(3),
    "chargesPaise" INTEGER,
    "reason" TEXT NOT NULL DEFAULT '',
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "filledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoSnapshot" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "bidPaise" INTEGER,
    "askPaise" INTEGER,
    "lastPaise" INTEGER,
    "unrealizedPaise" INTEGER,
    "stopPaise" INTEGER,

    CONSTRAINT "AutoSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoEvent" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "strategyKey" TEXT,
    "level" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoReport" (
    "date" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoReport_pkey" PRIMARY KEY ("date")
);

-- CreateIndex
CREATE INDEX "AutoDay_date_idx" ON "AutoDay"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AutoDay_strategyKey_date_key" ON "AutoDay"("strategyKey", "date");

-- CreateIndex
CREATE INDEX "AutoSignal_date_idx" ON "AutoSignal"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AutoSignal_strategyKey_date_tradeNo_key" ON "AutoSignal"("strategyKey", "date", "tradeNo");

-- CreateIndex
CREATE INDEX "AutoTrade_date_idx" ON "AutoTrade"("date");

-- CreateIndex
CREATE INDEX "AutoTrade_status_idx" ON "AutoTrade"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AutoTrade_strategyKey_date_tradeNo_key" ON "AutoTrade"("strategyKey", "date", "tradeNo");

-- CreateIndex
CREATE UNIQUE INDEX "AutoOrder_idempotencyKey_key" ON "AutoOrder"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AutoOrder_strategyKey_date_idx" ON "AutoOrder"("strategyKey", "date");

-- CreateIndex
CREATE INDEX "AutoSnapshot_tradeId_at_idx" ON "AutoSnapshot"("tradeId", "at");

-- CreateIndex
CREATE INDEX "AutoEvent_date_at_idx" ON "AutoEvent"("date", "at");

-- CreateIndex
CREATE INDEX "AutoEvent_strategyKey_date_idx" ON "AutoEvent"("strategyKey", "date");

