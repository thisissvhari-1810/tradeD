import { z } from "zod";

export const emailSchema = z.string().trim().email().max(160).transform((value) => value.toLowerCase());

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const mfaSchema = z.object({
  challengeToken: z.string().min(20),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

export const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(128),
});

export const setupSchema = z.object({
  setupToken: z.string().min(8),
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  password: z.string().min(10).max(128),
});

export const orderSchema = z.object({
  symbol: z.string().trim().min(1).max(20),
  side: z.enum(["BUY", "SELL"]),
  type: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT", "TARGET"]),
  quantity: z.number().int().positive(),
  limitRupees: z.string().optional(),
  stopRupees: z.string().optional(),
  idempotencyKey: z.string().min(8).max(80),
});

export const userCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  password: z.string().min(10).max(128),
  role: z.enum(["SUPER_ADMIN", "INSTRUCTOR", "STUDENT"]),
  startingRupees: z.string().optional(),
  classId: z.string().optional(),
});

export const fundsSchema = z.object({
  amountRupees: z.string().min(1),
  direction: z.enum(["credit", "debit"]),
  reason: z.string().trim().min(3).max(300),
});

export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const accessSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
  tradingEnabled: z.boolean().optional(),
  reason: z.string().trim().min(3).max(300),
});

export const journalSchema = z.object({
  orderId: z.string().optional(),
  thesis: z.string().trim().min(3).max(2000),
  expectedMove: z.string().max(500).optional(),
  plannedExit: z.string().max(500).optional(),
  riskReward: z.string().max(20).optional(),
  emotion: z.string().max(40).optional(),
  lesson: z.string().max(2000).optional(),
  mistakeTag: z.string().max(40).optional(),
});

export const classSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(500).optional(),
  instructorId: z.string().optional(),
});

export const competitionSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().max(1000).optional(),
  classId: z.string().optional(),
  startsAt: z.string().min(4),
  endsAt: z.string().min(4),
  returnWeight: z.number().int().min(0).max(100).default(50),
  drawdownWeight: z.number().int().min(0).max(100).default(30),
  learningWeight: z.number().int().min(0).max(100).default(20),
});

export const lessonSchema = z.object({
  title: z.string().trim().min(3).max(140),
  summary: z.string().trim().min(3).max(300),
  body: z.string().trim().min(20).max(20000),
  level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]),
  pathSlug: z.string().min(2),
  videoUrl: z.string().max(300).optional(),
});

export const alertSchema = z.object({
  symbol: z.string().min(1),
  condition: z.enum(["PRICE_ABOVE", "PRICE_BELOW"]),
  targetRupees: z.string().min(1),
  note: z.string().max(200).optional(),
});
