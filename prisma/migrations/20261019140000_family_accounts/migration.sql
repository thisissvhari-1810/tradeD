-- AlterTable
ALTER TABLE "BrokerAccount" ADD COLUMN     "ipConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "staticIp" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "BrokerConsent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrokerConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrokerConsent_accountId_createdAt_idx" ON "BrokerConsent"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "BrokerConsent" ADD CONSTRAINT "BrokerConsent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

