import { AppError } from "@/lib/http";

/**
 * Per-user feature permissions, set by the Super Admin and enforced on the server for every request.
 * "Standard Trading" is the existing User.tradingEnabled switch; the rest are User.feat* columns.
 */
export const FEATURES = [
  { key: "standardTrading", column: "tradingEnabled", label: "Standard Trading", detail: "Place orders on the user's own practice wallets." },
  { key: "demoTrading", column: "featDemoTrading", label: "Demo Trading", detail: "Paper trading in Demo and Live view." },
  { key: "replay", column: "featReplay", label: "Historical Replay", detail: "Replay past sessions and trade them." },
  { key: "multiAccount", column: "featMultiAccount", label: "Multi-Account Trading", detail: "Accounts dashboard, family accounts and multi-account orders." },
  { key: "brokerConnection", column: "featBrokerConnection", label: "Broker Connection", detail: "Connect a Dhan account through Dhan's sign-in." },
  { key: "portfolio", column: "featPortfolio", label: "Portfolio Access", detail: "View wallet balance, positions and holdings." },
  { key: "orderHistory", column: "featOrderHistory", label: "Order History", detail: "View orders and trade history." },
  { key: "analytics", column: "featAnalytics", label: "Analytics Access", detail: "Prediction and analytics screens." },
] as const;

export type FeatureKey = (typeof FEATURES)[number]["key"];
export type FeatureColumn = (typeof FEATURES)[number]["column"];
export type Features = Record<FeatureKey, boolean>;

export const FEATURE_KEYS = FEATURES.map((item) => item.key) as FeatureKey[];

/** Builds the feature map from a user row (any object with the feature columns). */
export function featuresOf(row: Partial<Record<FeatureColumn, boolean>>): Features {
  return Object.fromEntries(FEATURES.map((item) => [item.key, row[item.column] !== false])) as Features;
}

/** Feature map -> column values, for writes. */
export function featureColumns(features: Partial<Features>): Partial<Record<FeatureColumn, boolean>> {
  const out: Partial<Record<FeatureColumn, boolean>> = {};
  for (const item of FEATURES) if (typeof features[item.key] === "boolean") out[item.column] = features[item.key];
  return out;
}

export function hasFeature(user: { features?: Features } | null | undefined, key: FeatureKey) {
  return Boolean(user?.features?.[key]);
}

export function requireFeature(user: { features?: Features } | null | undefined, key: FeatureKey) {
  if (!hasFeature(user, key)) {
    const label = FEATURES.find((item) => item.key === key)?.label ?? key;
    throw new AppError(`${label} is not enabled for your account.`, 403, "FEATURE_DISABLED", { details: { feature: key } });
  }
}
