-- Removes Mathi 5%, Mathi Bank Strategy and Algo - Primary Strategy with their saved data (Mathi Strategy and Mathi Hourly Zone Strategy untouched).
-- Refused while one of them still has an open position or a pending order: nothing would manage it afterwards.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AlgoSession" WHERE jsonb_typeof("mathi5State"->'position') = 'object' OR jsonb_typeof("mathi5State"->'pending') = 'object' OR jsonb_typeof("mathiBankState"->'position') = 'object' OR jsonb_typeof("mathiBankState"->'pending') = 'object')
    OR EXISTS (SELECT 1 FROM "AlgoRun" WHERE "strategy" IN ('PRIMARY_STRATEGY', 'MATHI_5', 'MATHI_BANK') AND "status" = 'ACTIVE' AND (jsonb_typeof("state"->'position') = 'object' OR jsonb_typeof("state"->'pending') = 'object')) THEN
    RAISE EXCEPTION 'Mathi 5%%, Mathi Bank Strategy or Algo - Primary Strategy still has an open position or pending order: exit it, then apply this migration.';
  END IF;
END $$;
-- The execution lock held by a removed strategy is released.
UPDATE "AlgoSession" SET "activeStrategy" = 'NONE' WHERE "activeStrategy" IN ('PRIMARY_STRATEGY', 'MATHI_5', 'MATHI_BANK');
-- Their live paper events, chart replay runs (with each run's events) and saved backtests.
DELETE FROM "AlgoEvent" WHERE "mode" IN ('MATHI_5', 'MATHI_BANK');
DELETE FROM "AlgoEvent" AS e USING "AlgoRun" AS r WHERE e."mode" = 'CHART' AND e."sessionId" = r."sessionId" AND e."runId" = r."id" AND r."strategy" IN ('PRIMARY_STRATEGY', 'MATHI_5', 'MATHI_BANK');
DELETE FROM "AlgoRun" WHERE "strategy" IN ('PRIMARY_STRATEGY', 'MATHI_5', 'MATHI_BANK');
DELETE FROM "AlgoBacktest" WHERE "strategy" IN ('PRIMARY_STRATEGY', 'MATHI_5', 'MATHI_BANK');
-- Their settings and live paper-trading state.
ALTER TABLE "AlgoSession" DROP COLUMN "primaryConfig";
ALTER TABLE "AlgoSession" DROP COLUMN "mathi5Config";
ALTER TABLE "AlgoSession" DROP COLUMN "mathi5State";
ALTER TABLE "AlgoSession" DROP COLUMN "mathiBankConfig";
ALTER TABLE "AlgoSession" DROP COLUMN "mathiBankState";
