export type ChargeSettings = {
  brokeragePercent: string;
  brokerageCapPaise: number;
  sttSellPercent: string;
  exchangePercent: string;
  sebiPerCrorePaise: number;
  stampBuyPercent: string;
  gstPercent: string;
  slippageBps: number;
  spreadBps: number;
};

export type RiskSettings = {
  maxOrderQuantity: number;
  maxOrderValuePaise: string;
  maxPositionPercent: string;
  staleRealtimeSeconds: number;
  staleDelayedSeconds: number;
  staleDemoSeconds: number;
  demoFillWhenClosed: boolean;
  allowedOrderTypes: Array<"MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TARGET">;
};

export const DEFAULT_STARTING_CAPITAL_PAISE = 10_000_000n;

export const DEFAULT_CHARGES: ChargeSettings = {
  brokeragePercent: "0.03",
  brokerageCapPaise: 2000,
  sttSellPercent: "0.1",
  exchangePercent: "0.00345",
  sebiPerCrorePaise: 1000,
  stampBuyPercent: "0.015",
  gstPercent: "18",
  slippageBps: 5,
  spreadBps: 2,
};

export const DEFAULT_RISK: RiskSettings = {
  maxOrderQuantity: 100000,
  maxOrderValuePaise: "500000000",
  maxPositionPercent: "100",
  staleRealtimeSeconds: 20,
  staleDelayedSeconds: 1200,
  staleDemoSeconds: 900,
  demoFillWhenClosed: true,
  allowedOrderTypes: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT", "TARGET"],
};

export type TradingSettings = {
  startingCapitalPaise: bigint;
  charges: ChargeSettings;
  risk: RiskSettings;
};
