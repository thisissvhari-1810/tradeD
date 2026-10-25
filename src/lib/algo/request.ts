import { z } from "zod";

/** Requests to /api/algo, checked on the server before any command runs. */

/** A chart replay session id: the replay date and a random suffix. */
export const ALGO_SESSION_ID = /^\d{4}-\d{2}-\d{2}\.[a-z0-9]{4,32}$/;
const session = z.string().regex(ALGO_SESSION_ID);
// The chart's replay clock advances in fractions of a second; like the other replay routes, the replay
// time is taken to the whole second (a timestamp, not a quantity: no fractional value is meaningful).
const cursor = z.number({ invalid_type_error: "The replay time (cursor) is missing." }).finite("The replay time (cursor) is not a number.").positive("The replay time (cursor) must be positive.").transform((value) => Math.floor(value));

export const algoRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), config: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("entries"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("exit") }).strict(),
  z.object({ action: z.literal("emergency") }).strict(),
  z.object({ action: z.literal("acknowledge") }).strict(),
  z.object({ action: z.literal("tick") }).strict(),
  z.object({ action: z.literal("chartMode") }).strict(),
  z.object({ action: z.literal("replay"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ action: z.literal("chartArm"), session, cursor }).strict(),
  z.object({ action: z.literal("chartStep"), session, cursor }).strict(),
  z.object({ action: z.literal("chartExit"), session, cursor, emergency: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("chartDisarm"), session }).strict(),
  z.object({ action: z.literal("chartReset"), session }).strict(),
]);
