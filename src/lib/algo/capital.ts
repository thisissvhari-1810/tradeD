/**
 * The Strategy Algo trades its own practice wallet (PracticeMode ALGO) on the shared ledger, opened once
 * with this capital. It is separate from the demo wallet, the live paper wallet and the options desk's
 * paper account: none of them can fund an algo order, and algo orders never touch them.
 */
export const ALGO_STARTING_CAPITAL_PAISE = 10_000_000n; // ₹1,00,000
