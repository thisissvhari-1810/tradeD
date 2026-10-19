import type { DemoDoc, PriceSource, Summary } from "@/lib/multi-account/engine";
import type { LiveGate } from "@/lib/multi-account/compliance";

export type MultiAccountView = {
  mode: "DEMO";
  doc: DemoDoc;
  summary: Summary;
  marks: Record<string, number | null>;
  priceSource: PriceSource;
  marketData: { provider: string; pricesAvailable: boolean; message: string };
  live: LiveGate;
  saved: boolean;
};
