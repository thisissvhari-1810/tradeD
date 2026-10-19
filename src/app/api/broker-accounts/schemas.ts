import { z } from "zod";

/** Only family relationships are accepted: SEBI limits a client's API orders to self and family. */
export const relationship = z.enum(["SELF", "SPOUSE", "DEPENDENT_CHILD", "DEPENDENT_PARENT"], {
  message: "Broker accounts must belong to you, your spouse, a dependent child or a dependent parent.",
});

export const nickname = z.string().trim().min(1, "Enter a nickname.").max(40, "Use 40 characters or fewer.").regex(/^[\p{L}\p{N} ._'-]+$/u, "Use letters, numbers, spaces and . _ ' - only.");

export const accountId = z.string().regex(/^c[a-z0-9]{20,32}$/, "Unknown account.");

export const createBody = z.object({ nickname, relationship }).strict();

export const updateBody = z.object({ nickname: nickname.optional(), relationship: relationship.optional() }).strict().refine((value) => value.nickname !== undefined || value.relationship !== undefined, "Nothing to change.");

export const actionBody = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["refresh", "disconnect", "connect"]) }).strict(),
  z.object({
    action: z.literal("configure"),
    clientId: z.string().trim().regex(/^\d{4,20}$/, "Dhan client id must be 4 to 20 digits."),
    appId: z.string().trim().min(4, "Paste the API key.").max(200),
    appSecret: z.string().trim().max(400).optional(),
    staticIp: z.string().trim().max(15),
    ipConfirmed: z.boolean(),
  }).strict(),
]);
