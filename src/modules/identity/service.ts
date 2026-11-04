/**
 * Identity module — registration, authentication, sessions, RBAC.
 * Framework-free: consumed by API routes, server components and workers.
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { generateSessionToken, hashPassword, sha256, verifyPassword } from "@/lib/crypto";
import { Errors } from "@/lib/errors";
import type { UserRole } from "@prisma/client";

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  organizationId?: string;
  workerProfileId?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized) || normalized.length > 254) {
    throw Errors.badRequest("Invalid email address");
  }
  return normalized;
}

// ── Registration ─────────────────────────────────────────────────────

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  role: UserRole;
  organizationName?: string;
}

export async function registerUser(input: RegisterInput): Promise<AuthContext> {
  const email = assertValidEmail(input.email);
  if (input.password.length < 8) throw Errors.badRequest("Password must be at least 8 characters");
  if (input.password.length > 200) throw Errors.badRequest("Password too long");
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw Errors.badRequest("Name must be 2-120 characters");

  const passwordHash = await hashPassword(input.password);

  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { emailNormalized: email } });
    if (existing) throw Errors.conflict("An account with this email already exists");

    const user = await tx.user.create({
      data: {
        email,
        emailNormalized: email,
        passwordHash,
        name,
        role: input.role,
      },
    });

    if (input.role === "WORKER") {
      const profile = await tx.workerProfile.create({ data: { userId: user.id } });
      return { user, workerProfileId: profile.id, organizationId: undefined };
    }

    if (input.role === "BUSINESS") {
      const orgName = input.organizationName?.trim();
      if (!orgName || orgName.length < 2 || orgName.length > 160) {
        throw Errors.badRequest("Organization name must be 2-160 characters");
      }
      const org = await tx.organization.create({
        data: { name: orgName, ownerId: user.id },
      });
      return { user, organizationId: org.id, workerProfileId: undefined };
    }

    return { user, organizationId: undefined, workerProfileId: undefined };
  });

  return toAuthContext(created.user, created.organizationId, created.workerProfileId);
}

// ── Login / sessions ─────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
  meta?: { ip?: string; userAgent?: string },
): Promise<{ context: AuthContext; token: string; expiresAt: Date }> {
  const normalized = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { emailNormalized: normalized },
    include: { organization: true, workerProfile: true },
  });

  // Uniform failure — no account enumeration.
  if (!user || user.status === "SUSPENDED") {
    // Burn comparable time to reduce timing signal.
    await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$fake$fake", password);
    throw Errors.unauthorized("Invalid email or password");
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) throw Errors.unauthorized("Invalid email or password");

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + env.sessionTtlDays * 24 * 3600 * 1000);
  await prisma.session.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt, ip: meta?.ip, userAgent: meta?.userAgent?.slice(0, 300) },
  });

  const context = toAuthContext(
    user,
    user.organization?.id,
    user.workerProfile?.id,
  );
  return { context, token, expiresAt };
}

export async function resolveSession(token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { organization: true, workerProfile: true } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  const user = session.user;
  if (user.status === "SUSPENDED") return null;
  return toAuthContext(user, user.organization?.id, user.workerProfile?.id);
}

export async function logout(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export function toAuthContext(
  user: { id: string; email: string; name: string; role: UserRole },
  organizationId?: string,
  workerProfileId?: string,
): AuthContext {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    organizationId,
    workerProfileId,
  };
}

// ── RBAC guards ──────────────────────────────────────────────────────

export function requireAuth(ctx: AuthContext | null): AuthContext {
  if (!ctx) throw Errors.unauthorized();
  return ctx;
}

export function requireRole(ctx: AuthContext | null, ...roles: UserRole[]): AuthContext {
  const c = requireAuth(ctx);
  if (!roles.includes(c.role)) throw Errors.forbidden();
  return c;
}

export function requireAdmin(ctx: AuthContext | null): AuthContext {
  return requireRole(ctx, "ADMIN");
}

/** Business context with a verified organization attached. */
export async function requireVerifiedOrg(ctx: AuthContext | null) {
  const c = requireRole(ctx, "BUSINESS");
  if (!c.organizationId) throw Errors.forbidden("No organization linked to this account");
  const org = await prisma.organization.findUnique({ where: { id: c.organizationId } });
  if (!org) throw Errors.notFound("Organization not found");
  return org;
}
