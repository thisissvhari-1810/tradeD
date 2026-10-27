-- Mathi 5%: its own settings and its own live paper-trading state (additive; Mathi Strategy and Primary untouched).
ALTER TABLE "AlgoSession" ADD COLUMN "mathi5Config" JSONB;
ALTER TABLE "AlgoSession" ADD COLUMN "mathi5State" JSONB;
