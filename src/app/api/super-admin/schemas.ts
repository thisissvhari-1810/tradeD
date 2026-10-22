import { z } from "zod";

const featureFlags = z.object({
  standardTrading: z.boolean(),
  demoTrading: z.boolean(),
  replay: z.boolean(),
  multiAccount: z.boolean(),
  brokerConnection: z.boolean(),
  portfolio: z.boolean(),
  orderHistory: z.boolean(),
  analytics: z.boolean(),
}).strict();

export const createUserBody = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80),
  email: z.string().trim().email("Enter a valid email address.").max(160),
  role: z.enum(["SUPER_ADMIN", "STUDENT"]),
  status: z.enum(["ACTIVE", "SUSPENDED"]),
  features: featureFlags,
  initialCreditRupees: z.number().min(0).max(1_00_00_000).nullable().optional(),
  notes: z.string().max(500).optional(),
}).strict();

export const updateUserBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email("Enter a valid email address.").max(160).optional(),
  notes: z.string().max(500).optional(),
  role: z.enum(["SUPER_ADMIN", "STUDENT"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
  features: featureFlags.partial().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Nothing to change.");

export const userActionBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("wallet"),
    wallet: z.enum(["DEMO", "LIVE"]),
    direction: z.enum(["credit", "debit"]),
    amountRupees: z.number().positive("Enter an amount above zero.").max(1_00_00_000),
    reason: z.string().trim().min(3, "Enter a reason for this adjustment.").max(200),
    key: z.string().uuid("Missing request key."),
    confirmed: z.literal(true, { message: "Confirm the adjustment first." }),
  }).strict(),
  z.object({ action: z.literal("password-link") }).strict(),
]);

export const userIdParam = z.string().regex(/^c[a-z0-9]{20,32}$/, "Unknown user.");
