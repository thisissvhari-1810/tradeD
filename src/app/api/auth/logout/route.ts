import { mutation } from "@/server/http";
import { clearSessionCookie, revokeCurrentSession } from "@/server/auth";

export const POST = mutation(async () => {
  await revokeCurrentSession();
  await clearSessionCookie();
  return Response.json({ ok: true });
});
