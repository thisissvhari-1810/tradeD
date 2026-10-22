-- AlterTable
ALTER TABLE "User" ADD COLUMN     "featAnalytics" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "featBrokerConnection" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "featDemoTrading" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "featMultiAccount" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "featOrderHistory" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "featPortfolio" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "featReplay" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notes" TEXT NOT NULL DEFAULT '';

