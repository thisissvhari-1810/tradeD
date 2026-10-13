import { paiseToRupees } from "@/lib/money";
import type { DemoQuote } from "@/lib/market/demo";

export function publicQuote(quote: DemoQuote) {
  return {
    symbol: quote.symbol,
    last: paiseToRupees(quote.lastPaise),
    bid: paiseToRupees(quote.bidPaise),
    ask: paiseToRupees(quote.askPaise),
    open: paiseToRupees(quote.openPaise),
    high: paiseToRupees(quote.highPaise),
    low: paiseToRupees(quote.lowPaise),
    previousClose: paiseToRupees(quote.previousClosePaise),
    volume: quote.volume.toString(),
    asOf: quote.asOf.toISOString(),
    mode: quote.mode,
    source: quote.source,
    marketOpen: quote.marketOpen,
    message: quote.message,
  };
}
