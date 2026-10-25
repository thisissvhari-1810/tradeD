import { requireFeature } from "@/lib/auth/features";
import { viewModeOf, walletKey } from "@/server/practice-account";
import { PRACTICE_ROLES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/money";
import { ALGO_STARTING_CAPITAL_PAISE } from "@/lib/algo/capital";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getStudentBundle } from "@/server/portfolio";

export const GET = query(async (request) => {
  const user = await requireUser(PRACTICE_ROLES);
  requireFeature(user, "portfolio");
  const mode = viewModeOf(request);
  // Viewing never opens the Algo wallet: it is opened (with its starting capital) when the Algo first trades.
  if (mode === "ALGO" && !(await prisma.virtualAccount.findUnique({ where: walletKey(user.id, "ALGO") }))) {
    return Response.json({ exists: false, startingCapital: formatInr(ALGO_STARTING_CAPITAL_PAISE), simulated: true });
  }
  return Response.json({ ...(await getStudentBundle(user.id, mode)), exists: true, simulated: true });
});
