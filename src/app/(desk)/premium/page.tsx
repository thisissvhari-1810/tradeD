"use client";

import { Suspense } from "react";
import { PremiumPage } from "@/components/premium/premium-page";

export default function Page() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center bg-premium text-sm text-premium-muted">Opening Premium…</div>}>
      <PremiumPage />
    </Suspense>
  );
}
