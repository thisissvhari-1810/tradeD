"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/api";

type ChainSideView = { ltp: number | null } | null;
export type ChainView = { symbol: string; available: boolean; message: string; asOf: string; expiry: string | null; expiries: string[]; lotSize: number | null; atmStrike: number | null; strikes: Array<{ strike: number; ce: ChainSideView; pe: ChainSideView }> };

/** Contract picker backed by the existing option-chain route: expiries, strikes and lot size come from market data only. */
export function useChain(reloadToken: number) {
  const [underlying, setUnderlyingState] = useState("NIFTY");
  const [expiry, setExpiryState] = useState("");
  const [strike, setStrike] = useState<number | null>(null);
  const [chain, setChain] = useState<ChainView | null>(null);
  const [chainError, setChainError] = useState("");
  const [chainLoading, setChainLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    const query = expiry ? `&expiry=${encodeURIComponent(expiry)}` : "";
    api<ChainView>(`/api/options/chain?symbol=${encodeURIComponent(underlying)}${query}`)
      .then((data) => {
        if (stop) return;
        setChain(data);
        setChainError(data.available ? "" : data.message || "The option chain is unavailable.");
        if (!expiry && data.expiry) setExpiryState(data.expiry);
        setStrike((current) => (current != null && data.strikes.some((row) => row.strike === current) ? current : data.atmStrike));
      })
      .catch((error: unknown) => { if (!stop) setChainError(error instanceof Error ? error.message : "The option chain is unavailable."); })
      .finally(() => { if (!stop) setChainLoading(false); });
    return () => { stop = true; };
  }, [underlying, expiry, reloadToken]);

  const setUnderlying = useCallback((next: string) => { setUnderlyingState(next); setExpiryState(""); setStrike(null); setChainLoading(true); }, []);
  const setExpiry = useCallback((next: string) => { setExpiryState(next); setChainLoading(true); }, []);

  return { underlying, expiry, strike, setUnderlying, setExpiry, setStrike, chain, chainError, chainLoading };
}
