import { requireFeature } from "@/lib/auth/features";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { liveAccountsView } from "@/server/multi-account-live";

export const maxDuration = 30;

export const GET = query(async () => {
  const user = await requireUser();
  requireFeature(user, "multiAccount");
  return Response.json(await liveAccountsView(user), { headers: { "Cache-Control": "no-store" } });
});
