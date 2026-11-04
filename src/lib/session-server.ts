/**
 * Server-side session helpers. Framework touchpoint — the only place
 * that imports next/headers. Everything below it stays framework-free.
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/env";
import { resolveSession, type AuthContext } from "@/modules/identity/service";

export async function getAuthContext(): Promise<AuthContext | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}
