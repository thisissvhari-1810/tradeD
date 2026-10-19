/** Dhan allows 10 order requests per second per client; stay under it even in demo so the live path has one shape. */
export const ORDER_RATE = { concurrency: 4, perSecond: 8 } as const;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs every leg concurrently within a concurrency cap and a start-rate cap.
 * Each leg settles independently: one failure never cancels or retries another.
 */
export async function executeLegs<T, R>(items: T[], run: (item: T, index: number) => Promise<R>, options: { concurrency: number; perSecond: number; sleep?: (ms: number) => Promise<void> } = ORDER_RATE): Promise<PromiseSettledResult<R>[]> {
  const sleep = options.sleep ?? wait;
  const gap = Math.ceil(1000 / Math.max(1, options.perSecond));
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  let started = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const slot = started++;
      if (slot > 0) await sleep(gap);
      try {
        results[index] = { status: "fulfilled", value: await run(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency), items.length) }, worker));
  return results;
}
