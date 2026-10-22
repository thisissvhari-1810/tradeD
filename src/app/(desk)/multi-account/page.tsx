import { MultiAccountDesk } from "@/components/multi-account/desk";
import { requirePageFeature } from "@/server/guard";

export default async function MultiAccountPage() {
  await requirePageFeature("multiAccount");
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <MultiAccountDesk />
    </div>
  );
}
