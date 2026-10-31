-- Mathi Hourly Zone Strategy — 5%: its own settings and its own live paper-trading state (additive; other strategies untouched).
ALTER TABLE "AlgoSession" ADD COLUMN "mathiHourlyConfig" JSONB;
ALTER TABLE "AlgoSession" ADD COLUMN "mathiHourlyState" JSONB;
