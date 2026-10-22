-- CreateEnum
CREATE TYPE "PracticeMode" AS ENUM ('DEMO', 'LIVE');

-- DropIndex
DROP INDEX "VirtualAccount_userId_key";

-- AlterTable
ALTER TABLE "VirtualAccount" ADD COLUMN     "mode" "PracticeMode" NOT NULL DEFAULT 'DEMO';

-- CreateIndex
CREATE UNIQUE INDEX "VirtualAccount_userId_mode_key" ON "VirtualAccount"("userId", "mode");

