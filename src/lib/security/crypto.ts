import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "crypto";
import { AppError } from "@/lib/http";

/**
 * Authenticated encryption for broker credentials (AES-256-GCM).
 * The envelope is bound to a context string (the broker account id), so a ciphertext copied
 * onto another account row fails to decrypt. ENCRYPTION_KEY is 32 random bytes in base64;
 * ENCRYPTION_KEY_PREVIOUS is read only for decryption while rotating keys.
 */

const VERSION = "v1";
const IV_BYTES = 12;

type Key = { id: string; bytes: Buffer };

function parseKey(raw: string | undefined, name: string): Key | null {
  const value = raw?.trim();
  if (!value) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new AppError(`${name} must be 32 random bytes encoded as base64.`, 503, "ENCRYPTION_KEY_INVALID");
  return { id: createHash("sha256").update(bytes).digest("hex").slice(0, 12), bytes };
}

function currentKey(env: NodeJS.ProcessEnv = process.env): Key {
  const key = parseKey(env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
  if (!key) throw new AppError("Credential encryption is not configured on the server.", 503, "ENCRYPTION_KEY_MISSING");
  return key;
}

function decryptionKeys(env: NodeJS.ProcessEnv = process.env): Key[] {
  return [parseKey(env.ENCRYPTION_KEY, "ENCRYPTION_KEY"), parseKey(env.ENCRYPTION_KEY_PREVIOUS, "ENCRYPTION_KEY_PREVIOUS")].filter((key): key is Key => key !== null);
}

export function encryptionConfigured(env: NodeJS.ProcessEnv = process.env) {
  try {
    return parseKey(env.ENCRYPTION_KEY, "ENCRYPTION_KEY") !== null;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string, context: string, env: NodeJS.ProcessEnv = process.env): { envelope: string; keyId: string } {
  const key = currentKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = [VERSION, key.id, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
  return { envelope, keyId: key.id };
}

export function decryptSecret(envelope: string, context: string, env: NodeJS.ProcessEnv = process.env): string {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new AppError("Stored credential could not be read.", 500, "CREDENTIAL_UNREADABLE");
  const [, keyId, iv, tag, body] = parts as [string, string, string, string, string];
  const key = decryptionKeys(env).find((item) => item.id === keyId);
  if (!key) throw new AppError("Stored credential was encrypted with a key the server no longer has.", 500, "CREDENTIAL_KEY_UNKNOWN");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("Stored credential failed its integrity check.", 500, "CREDENTIAL_TAMPERED");
  }
}

/** Keyed fingerprint of a broker client id: lets the database enforce uniqueness without holding the id. */
export function fingerprint(value: string, purpose: string, env: NodeJS.ProcessEnv = process.env): string {
  const subkey = Buffer.from(hkdfSync("sha256", currentKey(env).bytes, Buffer.alloc(0), `tradeD:${purpose}`, 32));
  return createHmac("sha256", subkey).update(value.trim()).digest("hex");
}
