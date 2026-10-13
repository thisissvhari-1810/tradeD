export type AppRole = "SUPER_ADMIN" | "INSTRUCTOR" | "STUDENT";

export type Action =
  | "users.manage"
  | "users.createStudent"
  | "funds.adjust"
  | "accounts.reset"
  | "trading.suspend"
  | "settings.manage"
  | "audit.read"
  | "reports.export"
  | "content.manage"
  | "classes.manage"
  | "journal.review"
  | "competitions.manage"
  | "orders.inspect"
  | "trade.self"
  | "learn.self";

const MATRIX: Record<AppRole, Action[]> = {
  SUPER_ADMIN: [
    "users.manage",
    "users.createStudent",
    "funds.adjust",
    "accounts.reset",
    "trading.suspend",
    "settings.manage",
    "audit.read",
    "reports.export",
    "content.manage",
    "classes.manage",
    "journal.review",
    "competitions.manage",
    "orders.inspect",
    "learn.self",
  ],
  INSTRUCTOR: ["users.createStudent", "content.manage", "classes.manage", "journal.review", "competitions.manage", "orders.inspect", "learn.self"],
  STUDENT: ["trade.self", "learn.self"],
};

export function can(role: AppRole, action: Action): boolean {
  return MATRIX[role].includes(action);
}

export function canReadStudent(actor: { id: string; role: AppRole }, studentUserId: string, instructorClassStudentIds: string[] = []): boolean {
  if (actor.role === "SUPER_ADMIN") return true;
  if (actor.id === studentUserId) return true;
  if (actor.role === "INSTRUCTOR") return instructorClassStudentIds.includes(studentUserId);
  return false;
}

export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  tradingEnabled: true,
  mfaEnabled: true,
  lastLoginAt: true,
  createdAt: true,
} as const;
