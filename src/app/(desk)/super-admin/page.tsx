import { SuperAdminConsole } from "@/components/super-admin/console";
import { requirePageUser } from "@/server/guard";

export default async function SuperAdminPage() {
  // Server-side gate: anyone who is not a Super Admin is redirected before any data is sent.
  await requirePageUser(["SUPER_ADMIN"]);
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <SuperAdminConsole />
    </div>
  );
}
