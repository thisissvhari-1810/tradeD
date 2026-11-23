import { notFound } from "next/navigation";
import { AutoStrategyPage } from "@/components/auto/auto-strategy";
import { AUTO_KEYS } from "@/lib/auto/strategies";
import { requirePageUser } from "@/server/guard";

export default async function AutomatedStrategyPage({ params }: { params: Promise<{ key: string }> }) {
  await requirePageUser(["SUPER_ADMIN"]);
  const { key } = await params;
  if (!AUTO_KEYS.includes(key as never)) notFound();
  return <div className="h-full min-h-0 overflow-y-auto"><AutoStrategyPage strategyKey={key} /></div>;
}
