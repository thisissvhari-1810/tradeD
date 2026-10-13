import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { searchInstruments } from "@/server/market";

export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const skip = Number(url.searchParams.get("skip") ?? "0");
  return Response.json(await searchInstruments(url.searchParams.get("q") ?? "", Number.isFinite(skip) ? skip : 0));
});
