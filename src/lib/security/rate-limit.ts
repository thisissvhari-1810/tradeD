import { AppError } from "@/lib/http";

/**
 * Fixed-window limiter held in function memory. On Vercel each instance keeps its own counts, so this
 * caps bursts per instance only; it protects the broker rate limits, not against a distributed attack.
 */

const windows = new Map<string, { start: number; count: number }>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const current = windows.get(key);
  if (!current || now - current.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 5000) for (const [item, value] of windows) if (now - value.start >= windowMs) windows.delete(item);
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    const retry = Math.ceil((current.start + windowMs - now) / 1000);
    throw new AppError(`Too many requests. Try again in ${retry} seconds.`, 429, "RATE_LIMITED", { details: { retryAfterSeconds: retry } });
  }
}

export function resetRateLimits() {
  windows.clear();
}
