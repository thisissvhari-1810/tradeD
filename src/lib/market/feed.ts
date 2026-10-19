export type FeedTrade = {
  kind: "trade";
  securityId: number;
  segment: number;
  price: number;
  time: number;
  dayVolume: number | null;
};

export type FeedDisconnect = {
  kind: "disconnect";
  code: number;
  message: string;
  retry: boolean;
};

export type FeedPacket = FeedTrade | FeedDisconnect;

const PACKET_SIZE: Partial<Record<number, number>> = { 2: 16, 4: 50, 8: 162, 50: 10 };

export function parseFeedPackets(buffer: Uint8Array): FeedPacket[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const packets: FeedPacket[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const code = view.getUint8(offset);
    const declared = view.getUint16(offset + 1, true);
    const known = PACKET_SIZE[code] ?? 0;
    let length = declared >= 8 ? declared : known;
    if (known && declared < known && offset + known <= buffer.length) length = known;
    if (length < 8 || offset + length > buffer.length) break;
    const packet = readPacket(view, offset, code, length);
    if (packet) packets.push(packet);
    offset += length;
  }
  return packets;
}

function readPacket(view: DataView, offset: number, code: number, length: number): FeedPacket | null {
  if (code === 50 && length >= 10) {
    const reason = view.getUint16(offset + 8, true);
    const problem = disconnectProblem(reason);
    return { kind: "disconnect", code: reason, message: problem.message, retry: problem.retry };
  }
  if (code === 2 && length >= 16) return trade(view, offset, null);
  if ((code === 4 || code === 8) && length >= 26) return trade(view, offset, view.getUint32(offset + 22, true));
  return null;
}

function trade(view: DataView, offset: number, dayVolume: number | null): FeedTrade | null {
  const price = view.getFloat32(offset + 8, true);
  const time = codeTime(view, offset);
  if (!Number.isFinite(price) || price <= 0 || time < 1_000_000_000) return null;
  const volume = dayVolume != null && dayVolume >= 0 ? dayVolume : null;
  return {
    kind: "trade",
    segment: view.getUint8(offset + 3),
    securityId: view.getUint32(offset + 4, true),
    price,
    time,
    dayVolume: volume,
  };
}

function codeTime(view: DataView, offset: number) {
  const code = view.getUint8(offset);
  return view.getInt32(offset + (code === 2 ? 12 : 14), true);
}

export function disconnectProblem(code: number) {
  if (code === 805) return { message: "Too many market-feed connections are open.", retry: false };
  if (code === 806) return { message: "Market-data access is not enabled for this account.", retry: false };
  if (code === 807) return { message: "The market-data access token has expired.", retry: false };
  if (code === 808 || code === 809 || code === 810) return { message: "The market feed rejected the sign-in.", retry: false };
  return { message: "The market feed disconnected.", retry: true };
}

/** Turn cumulative day volume into the contracts traded since the previous packet. */
export function intervalVolume(previous: number | null, cumulative: number) {
  if (!Number.isFinite(cumulative) || cumulative < 0) return { delta: 0, baseline: previous };
  if (previous == null || cumulative < previous) return { delta: 0, baseline: cumulative };
  const delta = cumulative - previous;
  if (delta > 20_000_000) return { delta: 0, baseline: cumulative };
  return { delta, baseline: cumulative };
}
