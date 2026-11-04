/**
 * PostgreSQL-backed job queue — production-acceptable fallback driver
 * (claim with FOR UPDATE SKIP LOCKED, retries with backoff, dead
 * letters, repeating schedules). Used automatically when Redis is not
 * reachable; BullMQ is used when it is. Same job contract either way.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface PgJobData {
  id: string;
  queue: string;
  name: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
}

const TABLE = "PgJob";

export async function ensurePgJobTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TABLE}" (
      "id" TEXT PRIMARY KEY,
      "queue" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "payload" JSONB,
      "attempts" INT NOT NULL DEFAULT 0,
      "maxAttempts" INT NOT NULL DEFAULT 3,
      "runAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "error" TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "pg_job_queue_runat" ON "${TABLE}" ("queue", "runAt")`);
}

export async function enqueue(
  queue: string,
  name: string,
  payload: unknown,
  opts?: { delayMs?: number; jobId?: string; maxAttempts?: number },
): Promise<void> {
  const runAt = new Date(Date.now() + (opts?.delayMs ?? 0));
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${TABLE}" ("id","queue","name","payload","runAt","maxAttempts") VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT ("id") DO NOTHING`,
    opts?.jobId ?? `${queue}:${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    queue,
    name,
    JSON.stringify(payload ?? {}),
    runAt,
    opts?.maxAttempts ?? 3,
  );
}

export async function scheduleRecurring(queue: string, name: string, payload: unknown, everyMs: number): Promise<void> {
  const jobId = `recurring:${queue}:${name}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${TABLE}" ("id","queue","name","payload","runAt","maxAttempts") VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT ("id") DO NOTHING`,
    jobId,
    queue,
    name,
    JSON.stringify({ ...(payload as object), everyMs }),
    new Date(),
    1,
  );
}

/** Claim one job atomically. Returns null when queue is empty. */
export async function claimJob(queue: string): Promise<PgJobData | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; queue: string; name: string; payload: unknown; attempts: number; maxAttempts: number; runAt: Date }>>(
    `UPDATE "${TABLE}" SET "runAt" = now() + interval '30 seconds', "attempts" = "attempts" + 1
     WHERE "id" = (
       SELECT "id" FROM "${TABLE}"
       WHERE "queue" = $1 AND "runAt" <= now()
       ORDER BY "runAt" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING "id","queue","name","payload","attempts","maxAttempts","runAt"`,
    queue,
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, queue: row.queue, name: row.name, payload: row.payload, attempts: row.attempts, maxAttempts: row.maxAttempts, runAt: row.runAt };
}

export async function completeJob(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "${TABLE}" WHERE "id" = $1`, id);
}

export async function failJob(job: PgJobData, error: string, backoffMs = 5000): Promise<"retry" | "dead"> {
  if (job.attempts >= job.maxAttempts) {
    await prisma.$executeRawUnsafe(`UPDATE "${TABLE}" SET "error" = $2, "runAt" = now() + interval '1 hour' WHERE "id" = $1`, job.id, error.slice(0, 1000));
    logger.error("pgjob_dead", { queue: job.queue, job: job.id, error: error.slice(0, 300) });
    return "dead";
  }
  const delay = backoffMs * Math.pow(2, job.attempts - 1);
  await prisma.$executeRawUnsafe(`UPDATE "${TABLE}" SET "error" = $2, "runAt" = now() + ($3 || ' milliseconds')::interval WHERE "id" = $1`, job.id, error.slice(0, 1000), String(delay));
  return "retry";
}

export async function queueDepth(queue: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "${TABLE}" WHERE "queue" = $1`, queue);
  return Number(rows[0]?.c ?? 0);
}
