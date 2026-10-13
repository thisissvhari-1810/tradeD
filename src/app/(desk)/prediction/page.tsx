"use client";

import { Suspense } from "react";
import { PredictionDesk } from "@/components/prediction-desk";

export default function PredictionPage() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">Opening prediction…</div>}>
      <PredictionDesk />
    </Suspense>
  );
}
