import type { ExecutionAdapter, Fill } from "./runner";

/**
 * Live algo execution: unavailable until it is validated. It never pretends to reach a broker: every
 * order is refused with the reason, and its health says why live trading is off.
 */
export function liveAdapter(reasons: string[]): ExecutionAdapter {
  const refuse = async (): Promise<Fill> => ({ status: "REJECTED", reason: reasons[0] ?? "Live algo execution is unavailable." });
  return {
    kind: "live",
    health: async () => ({ ok: false, reason: reasons.join(" ") }),
    cash: async () => 0,
    charges: () => 0,
    chain: async () => { throw new Error("Live algo execution is unavailable."); },
    mark: async () => null,
    enter: refuse,
    exit: refuse,
    lookup: async () => null,
  };
}
