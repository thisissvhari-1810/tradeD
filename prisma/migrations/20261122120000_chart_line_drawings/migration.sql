-- Line Strategy Draw: saved chart line drawings per user (additive; nothing else changes).
CREATE TABLE "ChartLineDrawing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT '*',
    "timeframe" TEXT NOT NULL DEFAULT 'all',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChartLineDrawing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChartLineDrawing_userId_position_idx" ON "ChartLineDrawing"("userId", "position");

ALTER TABLE "ChartLineDrawing" ADD CONSTRAINT "ChartLineDrawing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
