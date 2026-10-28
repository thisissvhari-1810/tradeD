import { z } from "zod";

/** Requests to /api/algo, checked on the server before any command runs. */

/** A chart replay session id: the replay date and a random suffix. */
export const ALGO_SESSION_ID = /^\d{4}-\d{2}-\d{2}\.[a-z0-9]{4,32}$/;
const session = z.string().regex(ALGO_SESSION_ID);
// The chart's replay clock advances in fractions of a second; like the other replay routes, the replay
// time is taken to the whole second (a timestamp, not a quantity: no fractional value is meaningful).
const strategy = z.enum(["EXISTING_ALGO", "PRIMARY_STRATEGY", "MATHI_5", "MATHI_BANK"]);
const cursor = z.number({ invalid_type_error: "The replay time (cursor) is missing." }).finite("The replay time (cursor) is not a number.").positive("The replay time (cursor) must be positive.").transform((value) => Math.floor(value));

export const algoRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), config: z.record(z.string(), z.unknown()), strategy: strategy.optional() }).strict(),
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("entries"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("exit") }).strict(),
  z.object({ action: z.literal("emergency") }).strict(),
  z.object({ action: z.literal("acknowledge") }).strict(),
  z.object({ action: z.literal("tick") }).strict(),
  z.object({ action: z.literal("chartMode") }).strict(),
  z.object({ action: z.literal("replay"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ action: z.literal("chartArm"), session, cursor, strategy: strategy.optional() }).strict(),
  z.object({ action: z.literal("chartStep"), session, cursor }).strict(),
  z.object({ action: z.literal("chartExit"), session, cursor, emergency: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("chartDisarm"), session }).strict(),
  z.object({ action: z.literal("chartReset"), session }).strict(),
  z.object({ action: z.literal("chartFinalize"), session }).strict(),
  z.object({ action: z.literal("stopStrategy"), strategy, exit: z.boolean() }).strict(),
  z.object({ action: z.literal("mathi5"), op: z.enum(["start", "stop", "tick", "exit"]) }).strict(),
  z.object({ action: z.literal("variant"), strategy: z.enum(["MATHI_5", "MATHI_BANK"]), op: z.enum(["start", "stop", "tick", "exit"]) }).strict(),
  z.object({ action: z.literal("backtestDay"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), variant: z.union([z.enum(["saved", "baseline"]), z.string().regex(/^(score:\d{1,3}|confirm:(single|hold|retest))$/)]), strategy: strategy.optional(), capital: z.number().min(1_000).max(100_000_000).optional(), slippageTicks: z.number().int().min(0).max(20).optional() }).strict(),
  // Saved backtests: the browser sends the days it ran; the server recomputes every total from them.
  z.object({
    action: z.literal("backtestSave"), strategy: strategy.optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    capital: z.number().min(1_000).max(100_000_000), mode: z.enum(["daily", "continuous", "both"]), slippageTicks: z.number().int().min(0).max(20),
    status: z.enum(["COMPLETED", "CANCELLED"]), runs: z.record(z.enum(["daily", "continuous"]), z.array(z.record(z.string(), z.unknown())).max(80)),
  }).strict(),
  z.object({ action: z.literal("backtestList") }).strict(),
  z.object({ action: z.literal("backtestGet"), id: z.string().regex(/^[a-z0-9]{8,40}$/) }).strict(),
  z.object({ action: z.literal("backtestDelete"), id: z.string().regex(/^[a-z0-9]{8,40}$/) }).strict(),
]);

export type AlgoRequest = z.infer<typeof algoRequest>;
