/**
 * Removes secrets from anything about to be logged or written to an audit row.
 * Keys that name a secret are replaced outright; strings are scrubbed of JWTs, bearer values
 * and token query parameters wherever they appear.
 */

const SECRET_KEY = /(token$|token[-_]?id$|secret|password|passwd|authorization|cookie|^otp$|api[-_]?key|ciphertext|envelope|^credentials?$)/i;
const CLIENT_KEY = /^(client[-_]?id|dhanClientId)$/i;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;
const QUERY_SECRET = /([?&](?:token|access[-_]?token|clientId|client_id|secret)=)[^&\s"']+/gi;

const MAX_DEPTH = 6;

export function redactString(value: string): string {
  return value.replace(JWT, "[redacted-jwt]").replace(BEARER, "$1 [redacted]").replace(QUERY_SECRET, "$1[redacted]");
}

export function maskTail(value: string, keep = 4): string {
  const trimmed = value.trim();
  if (trimmed.length <= keep) return "••••";
  return `${"•".repeat(Math.min(6, trimmed.length - keep))}${trimmed.slice(-keep)}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactString(value);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (value instanceof Error) {
    const code = "code" in value ? String((value as { code: unknown }).code) : undefined;
    return { name: value.name, message: redactString(value.message), ...(code ? { code } : {}) };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) out[key] = "[redacted]";
      else if (CLIENT_KEY.test(key) && (typeof item === "string" || typeof item === "number")) out[key] = maskTail(String(item));
      else out[key] = redact(item, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}
