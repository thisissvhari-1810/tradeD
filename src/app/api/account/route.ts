import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { brokerAccountView } from "@/server/dhan-account";
import { configuredProvider } from "@/server/settings";

export const GET = query(async () => {
  await requireUser();
  const broker = await brokerAccountView();
  return Response.json({ provider: configuredProvider(), broker });
});
