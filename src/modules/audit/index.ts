/**
 * Audit module — append-only trail of every significant action.
 * Never throws into caller business flow; audit failures are logged.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(entry: AuditEntry, tx?: Pick<Parameters<Parameters<typeof prisma.$transaction>[0]>[0], "auditLog">): Promise<void> {
  const data = {
    actorId: entry.actorId ?? null,
    actorRole: entry.actorRole ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: (entry.metadata ?? undefined) as never,
    ip: entry.ip ?? null,
  };
  try {
    if (tx) await tx.auditLog.create({ data });
    else await prisma.auditLog.create({ data });
  } catch (e) {
    logger.error("audit_write_failed", { action: entry.action, error: String(e) });
  }
}
