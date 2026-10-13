"use client";

import { Suspense } from "react";
import { ChartDesk } from "@/components/chart-desk";

export default function PositionsPage() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">Opening positions…</div>}>
      <ChartDesk variant="positions" />
    </Suspense>
  );
}
