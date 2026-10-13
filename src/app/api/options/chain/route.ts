import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { loadOptionChain } from "@/server/option-chain";

export const maxDuration = 30;

export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.trim() || "NIFTY";
  const expiry = url.searchParams.get("expiry");
  return Response.json(await loadOptionChain(symbol, expiry));
});
