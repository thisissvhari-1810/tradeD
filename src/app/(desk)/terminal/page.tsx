"use client";

import { Suspense } from "react";
import { Terminal } from "@/components/terminal";

export default function TerminalPage() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">Opening terminal…</div>}>
      <Terminal />
    </Suspense>
  );
}
