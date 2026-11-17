"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";
import type { MarketAnalysis } from "@/lib/algo/patterns";
import type { AlgoData } from "@/components/algo/algo-panel";
import { useSelectedStrategy } from "@/components/algo/algo-settings-sync";
import { variantData } from "@/components/algo/algo-start-button";
import { isVariantStrategy } from "@/lib/algo/exclusive";

/**
 * The live-price paper Algo's market analysis for the chart (outside replay): read from the server every
 * 30 seconds while the page is visible, used only when the Algo is in paper mode on this chart's symbol
 * and the analysis is from today's session (an older one is never drawn as current). With Mathi Hourly Zone Strategy or
 * Mathi Trend Channel selected, its own analysis (hourly pairs / the channel, levels and setups) is drawn instead.
 */
export function useLiveAlgoAnalysis({ enabled, symbol }: { enabled: boolean; symbol: string }): MarketAnalysis | null {
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null);
  const [selected] = useSelectedStrategy();
  const variant = isVariantStrategy(selected) ? selected : null;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => {
      if (document.hidden) return;
      api<AlgoData>("/api/algo")
        .then((data) => {
          if (!live) return;
          const view = variant ? variantData(data, variant) : data;
          const found = view.state.analysis ?? null;
          const fresh = found != null && Date.now() / 1000 - found.asOf < 8 * 3600;
          setAnalysis(data.config.mode === "PAPER" && view.config.underlying === symbol && fresh ? found : null);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [enabled, symbol, variant]);
  return enabled ? analysis : null;
}
