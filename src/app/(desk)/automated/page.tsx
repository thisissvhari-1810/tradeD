import { AutoDashboard } from "@/components/auto/auto-dashboard";
import { requirePageUser } from "@/server/guard";

export default async function AutomatedPage() {
  await requirePageUser(["SUPER_ADMIN"]);
  return <div className="h-full min-h-0 overflow-y-auto"><AutoDashboard /></div>;
}
