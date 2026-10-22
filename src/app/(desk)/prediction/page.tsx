import { Suspense } from "react";
import { PredictionDesk } from "@/components/prediction-desk";
import { requirePageFeature } from "@/server/guard";

export default async function PredictionPage() {
  await requirePageFeature("analytics");
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">Opening prediction…</div>}>
      <PredictionDesk />
    </Suspense>
  );
}
