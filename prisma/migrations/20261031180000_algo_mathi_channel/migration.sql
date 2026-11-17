-- Mathi Trend Channel: its own settings and its own live paper-trading state (additive; other strategies untouched).
ALTER TABLE "AlgoSession" ADD COLUMN "mathiChannelConfig" JSONB;
ALTER TABLE "AlgoSession" ADD COLUMN "mathiChannelState" JSONB;
