import { query } from "@/server/http";
import { getSessionUser } from "@/server/auth";

export const GET = query(async () => {
  const user = await getSessionUser();
  if (!user) return Response.json({ user: null });
  return Response.json({
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      tradingEnabled: user.tradingEnabled,
      features: user.features,
      premium: user.premium,
    },
  });
});
