"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/env";
import { login, registerUser, logout } from "@/modules/identity";
import { audit } from "@/modules/audit";
import { ensureChartOfAccounts } from "@/modules/finance";
import { rateLimit } from "@/lib/rate-limit";

export interface ActionState { error?: string; success?: string }

export async function loginAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const ip = "rate-limited";

  if (!(await rateLimit(`login:${email}`, 5, 60))) {
    return { error: "Too many login attempts. Try again in a minute." };
  }

  try {
    const { context, token, expiresAt } = await login(email, password);
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: expiresAt,
      path: "/",
    });
    await audit({ actorId: context.userId, actorRole: context.role, action: "auth.login", entityType: "user", entityId: context.userId, ip });
    return { success: "ok" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Login failed" };
  }
}

export async function registerAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const role = String(formData.get("role") ?? "WORKER") as "WORKER" | "BUSINESS";
  if (!(await rateLimit(`register:${String(formData.get("email") ?? "")}`, 3, 3600))) {
    return { error: "Too many registration attempts. Try again later." };
  }
  try {
    await ensureChartOfAccounts();
    const context = await registerUser({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      name: String(formData.get("name") ?? ""),
      role,
      organizationName: role === "BUSINESS" ? String(formData.get("organizationName") ?? "") : undefined,
    });
    await audit({ actorId: context.userId, actorRole: role, action: "auth.register", entityType: "user", entityId: context.userId });
    // Auto-login after registration
    const { token, expiresAt } = await login(String(formData.get("email") ?? ""), String(formData.get("password") ?? ""));
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: expiresAt,
      path: "/",
    });
    return { success: "ok" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Registration failed" };
  }
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await logout(token);
    await audit({ action: "auth.logout", entityType: "session" });
  }
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
