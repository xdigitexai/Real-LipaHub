/**
 * Worker process entrypoint — consumes all queues on whichever driver
 * is available (BullMQ w/ Redis, PostgreSQL SKIP LOCKED otherwise).
 * Run with: npm run worker
 */
import "dotenv/config";
import { logger } from "@/lib/logger";
import { QUEUE_NAMES, type QueueName } from "./queues";
import { detectDriver, scheduleOperationsSweep } from "./enqueue";
import { ensurePgJobTable, claimJob, completeJob, failJob, type PgJobData } from "./pg-queue";
import { ingestSource } from "@/modules/opportunities";
import { ensureChartOfAccounts } from "@/modules/finance";
import { prisma } from "@/lib/db";

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

async function handleIngestSource(payload: Record<string, unknown>): Promise<unknown> {
  const sourceId = String(payload.sourceId ?? "");
  const actorId = payload.actorId ? String(payload.actorId) : undefined;
  logger.info("job_discovery_start", { sourceId });
  const result = await ingestSource({ sourceId, actorId });
  logger.info("job_discovery_done", { sourceId, ...result });
  return result;
}

async function handleOperationsSweep(): Promise<unknown> {
  // Stale RUNNING agent runs → TIMEOUT
  const stale = await prisma.agentRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "TIMEOUT", error: "Operations sweep: run exceeded 10 minutes", finishedAt: new Date() },
  });
  // Failing sources → admin notification
  const failingSources = await prisma.opportunitySource.count({ where: { consecutiveFailures: { gte: 3 } } });
  if (failingSources > 0) {
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    for (const admin of admins) {
      await prisma.notification.create({
        data: {
          userId: admin.id,
          type: "operations.source_failures",
          title: "Opportunity sources failing",
          body: `${failingSources} source(s) have failed 3+ consecutive fetches. Review the source manager.`,
          link: "/admin/opportunities/sources",
        },
      }).catch(() => {});
    }
  }
  logger.info("job_operations_done", { staleRuns: stale.count, failingSources });
  return { staleRuns: stale.count, failingSources };
}

const handlers: Record<QueueName, Record<string, Handler>> = {
  discovery: { "ingest-source": handleIngestSource },
  evaluation: {},
  verification: {},
  operations: { sweep: () => handleOperationsSweep() },
};

async function runPgDriverLoop(): Promise<void> {
  await ensurePgJobTable();
  await scheduleOperationsSweep();
  logger.info("worker_started", { driver: "postgres", queues: Object.keys(QUEUE_NAMES) });

  let stopped = false;
  const shutdown = async () => {
    stopped = true;
    logger.info("worker_shutting_down");
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopped) {
    let worked = false;
    for (const queue of Object.keys(QUEUE_NAMES) as QueueName[]) {
      let job: PgJobData | null = null;
      try {
        job = await claimJob(queue);
      } catch (e) {
        logger.error("pgjob_claim_failed", { queue, error: String(e).slice(0, 200) });
        continue;
      }
      if (!job) continue;
      worked = true;
      const handler = handlers[queue][job.name];
      // Recurring sweep: after completion, re-enqueue the next occurrence.
      const isRecurring = job.id.startsWith("recurring:");
      try {
        if (!handler) throw new Error(`No handler for ${queue}/${job.name}`);
        await handler((job.payload ?? {}) as Record<string, unknown>);
        await completeJob(job.id);
        if (isRecurring) {
          const everyMs = Number((job.payload as { everyMs?: number })?.everyMs ?? 300_000);
          await (await import("./pg-queue")).enqueue(queue, job.name, job.payload, { delayMs: everyMs, jobId: job.id });
        }
      } catch (e) {
        await failJob(job, String((e as Error).message ?? e));
        if (isRecurring) {
          // Never lose the recurring schedule due to a failed run.
          await (await import("./pg-queue")).enqueue(queue, job.name, job.payload, { delayMs: 60_000, jobId: job.id });
        }
      }
    }
    if (!worked) await new Promise((r) => setTimeout(r, 1500));
  }
}

async function runBullmqDriver(): Promise<void> {
  const { Worker } = await import("bullmq");
  const { getRedis } = await import("@/lib/rate-limit");
  await ensureChartOfAccounts();
  const connection = getRedis();

  const bullHandlers: Record<QueueName, (payload: Record<string, unknown>) => Promise<unknown>> = {
    discovery: handleIngestSource,
    evaluation: async () => ({}),
    verification: async () => ({}),
    operations: async (p) => handlers.operations[p.name as string]?.(p) ?? handleOperationsSweep(),
  };

  const workers = (Object.keys(QUEUE_NAMES) as QueueName[]).map(
    (name) =>
      new Worker(name, async (job) => bullHandlers[name]((job.data ?? {}) as Record<string, unknown>), {
        connection,
        concurrency: name === "discovery" ? 2 : 4,
      }),
  );
  for (const w of workers) {
    w.on("failed", (job, err) => logger.error("job_failed", { queue: name, job: job?.id, error: err.message }));
  }
  logger.info("worker_started", { driver: "bullmq", queues: Object.keys(QUEUE_NAMES) });
  await scheduleOperationsSweep();

  const shutdown = async () => {
    logger.info("worker_shutting_down");
    await Promise.allSettled(workers.map((w) => w.close()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  await ensureChartOfAccounts();
  const driver = await detectDriver();
  if (driver === "bullmq") await runBullmqDriver();
  else await runPgDriverLoop();
}

main().catch((e) => {
  logger.error("worker_fatal", { error: String(e) });
  process.exit(1);
});
