"use client";
import { Suspense } from "react";
import { OptionsScreen } from "@/components/screens";

export default function Page() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">Opening the option chain…</div>}>
      <OptionsScreen />
    </Suspense>
  );
}
