import { describe, expect, it } from "vitest";
import { intervalVolume, parseFeedPackets } from "@/lib/market/feed";

function quotePacket(price: number, time: number, volume: number, securityId = 1333) {
  const bytes = new Uint8Array(50);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 4);
  view.setUint16(1, 50, true);
  view.setUint8(3, 1);
  view.setUint32(4, securityId, true);
  view.setFloat32(8, price, true);
  view.setUint16(12, 10, true);
  view.setInt32(14, time, true);
  view.setUint32(22, volume, true);
  return bytes;
}

describe("market feed packets", () => {
  it("reads price, trade time, and cumulative volume from a quote packet", () => {
    const [packet] = parseFeedPackets(quotePacket(2450.5, 1_700_000_000, 5000));
    expect(packet).toMatchObject({ kind: "trade", securityId: 1333, segment: 1, time: 1_700_000_000, dayVolume: 5000 });
    if (packet?.kind === "trade") expect(packet.price).toBeCloseTo(2450.5, 2);
  });

  it("splits concatenated packets and reads a disconnect code", () => {
    const quote = quotePacket(100, 1_700_000_100, 10);
    const disconnect = new Uint8Array(10);
    const view = new DataView(disconnect.buffer);
    view.setUint8(0, 50);
    view.setUint16(1, 10, true);
    view.setUint16(8, 806, true);
    const combined = new Uint8Array(quote.length + disconnect.length);
    combined.set(quote, 0);
    combined.set(disconnect, quote.length);
    const packets = parseFeedPackets(combined);
    expect(packets).toHaveLength(2);
    expect(packets[1]).toMatchObject({ kind: "disconnect", code: 806, retry: false });
  });

  it("does not turn the first cumulative volume into candle volume", () => {
    const first = intervalVolume(null, 800_000);
    expect(first).toEqual({ delta: 0, baseline: 800_000 });
    const next = intervalVolume(first.baseline, 800_040);
    expect(next).toEqual({ delta: 40, baseline: 800_040 });
    const reset = intervalVolume(next.baseline, 20);
    expect(reset).toEqual({ delta: 0, baseline: 20 });
  });
});
