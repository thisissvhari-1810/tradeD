import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { dhanIndices } from "@/server/dhan-market";

export const GET = query(async () => {
  await requireUser();
  return Response.json(await dhanIndices());
});
