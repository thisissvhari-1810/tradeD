import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getQuote } from "@/server/market";
import { publicQuote } from "@/server/public-quote";

export const GET = query(async (request) => {
  await requireUser();
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  return Response.json(publicQuote(await getQuote(symbol)));
});
