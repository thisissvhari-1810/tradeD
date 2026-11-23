import { AutoReports } from "@/components/auto/auto-reports";
import { kolkataParts } from "@/lib/market/clock";
import { requirePageUser } from "@/server/guard";

export default async function AutomatedReportsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  await requirePageUser(["SUPER_ADMIN"]);
  const { date } = await searchParams;
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : kolkataParts(new Date()).dateKey;
  return <div className="h-full min-h-0 overflow-y-auto"><AutoReports initialDate={day} /></div>;
}
