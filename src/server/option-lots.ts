import { getDhanAccessToken, getDhanClientId } from "@/server/settings";

const CACHE_MS = 6 * 60 * 60 * 1000;
let cache: { at: number; lots: Map<string, number> } | null = null;

export function lotsFromMaster(csv: string) {
  const lots = new Map<string, number>();
  const lines = csv.split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((cell) => cell.trim());
  const idIndex = header.findIndex((cell) => cell === "SECURITY_ID" || cell === "SEM_SMST_SECURITY_ID");
  const lotIndex = header.findIndex((cell) => cell === "LOT_SIZE" || cell === "SEM_LOT_UNITS");
  const typeIndex = header.findIndex((cell) => cell === "OPTION_TYPE" || cell === "SEM_OPTION_TYPE");
  if (idIndex < 0 || lotIndex < 0) return lots;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = line.split(",");
    const type = typeIndex >= 0 ? cells[typeIndex]?.trim() : "CE";
    if (type !== "CE" && type !== "PE") continue;
    const id = cells[idIndex]?.trim();
    const lot = Number(cells[lotIndex]);
    if (id && /^\d{1,12}$/.test(id) && Number.isInteger(lot) && lot > 0) lots.set(id, lot);
  }
  return lots;
}

export async function optionLotSize(securityId: string) {
  if (!/^\d{1,12}$/.test(securityId)) return null;
  const lots = await derivativeLots();
  return lots.get(securityId) ?? null;
}

async function derivativeLots() {
  if (cache && Date.now() - cache.at < CACHE_MS && cache.lots.size > 0) return cache.lots;
  const headers: Record<string, string> = { Accept: "text/csv,text/plain", "access-token": await getDhanAccessToken() };
  const clientId = await getDhanClientId();
  if (clientId) headers["client-id"] = clientId;
  const response = await fetch("https://api.dhan.co/v2/instrument/NSE_FNO", {
    headers,
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok) return cache?.lots ?? new Map<string, number>();
  const lots = lotsFromMaster(await response.text());
  if (lots.size > 0) cache = { at: Date.now(), lots };
  return lots;
}
