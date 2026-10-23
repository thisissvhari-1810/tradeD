import { Suspense } from "react";
import { PredictionDesk } from "@/components/prediction-desk";
import { redirect } from "next/navigation";
import { canUse } from "@/lib/premium/entitlements";
import { requirePageFeature } from "@/server/guard";

export default async function PredictionPage() {
  const user = await requirePageFeature("analytics");
  // Prediction is Premium: free and expired accounts see the Premium page instead.
  if (!canUse(user.premium, "analytics")) redirect("/premium?feature=analytics");
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">Opening prediction…</div>}>
      <PredictionDesk />
    </Suspense>
  );
}
