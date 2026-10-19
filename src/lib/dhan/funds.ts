import type { DhanClient } from "@/lib/dhan/client";

/**
 * Account reads. Each returns the raw broker payload; normalisation lives in lib/multi-account/live.
 * None of these need the static IP: Dhan requires it only for order placement, modification and cancellation.
 */

export type DhanProfile = { dhanClientId?: string; tokenValidity?: string; activeSegment?: string; dataPlan?: string; dataValidity?: string };

export const readProfile = (client: DhanClient) => client.get<DhanProfile>("/profile");
export const readFunds = (client: DhanClient) => client.get("/fundlimit");
export const readPositions = (client: DhanClient) => client.get("/positions");
export const readHoldings = (client: DhanClient) => client.get("/holdings");
export const readOrders = (client: DhanClient) => client.get("/orders");
