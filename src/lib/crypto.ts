import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ARGON_OPTS = { memory: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain, ARGON_OPTS);
  } catch {
    return false;
  }
}

/** 256-bit opaque session token. Only its SHA-256 is persisted. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}
