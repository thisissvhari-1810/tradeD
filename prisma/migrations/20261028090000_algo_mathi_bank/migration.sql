-- Mathi Bank Strategy: its own settings and its own live paper-trading state (additive; other strategies untouched).
ALTER TABLE "AlgoSession" ADD COLUMN "mathiBankConfig" JSONB;
ALTER TABLE "AlgoSession" ADD COLUMN "mathiBankState" JSONB;
