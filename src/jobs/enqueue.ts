/**
 * Queue abstraction — BullMQ when Redis is reachable (platform
 * preference), PostgreSQL SKIP LOCKED driver otherwise. Callers use
 * enqueueDiscovery / runWorkerSweep without caring which driver is
 * active. Driver selection is logged at startup, never silent.
 */
import { logger } from "@/lib/logger";
import { getRedis } from "@/lib/rate-limit";
import { QUEUE_NAMES, type QueueName } from "./queues";
import { enqueue as pgEnqueue, ensurePgJobTable, scheduleRecurring as pgScheduleRecurring } from "./pg-queue";

export type QueueDriver = "bullmq" | "postgres";

let driver: QueueDriver | null = null;

export async function detectDriver(): Promise<QueueDriver> {
  if (driver) return driver;
  try {
    const redis = getRedis();
    await redis.ping();
    driver = "bullmq";
    logger.info("queue_driver_selected", { driver });
  } catch {
    driver = "postgres";
    logger.warn("queue_driver_selected", { driver, reason: "redis unreachable — using PostgreSQL-backed queue" });
  }
  return driver;
}

export async function enqueueJob(queue: QueueName, name: string, payload: unknown, opts?: { delayMs?: number; jobId?: string }): Promise<void> {
  const d = await detectDriver();
  if (d === "bullmq") {
    const { getQueue } = await import("./queues");
    await getQueue(queue).add(name, payload, { jobId: opts?.jobId });
    return;
  }
  await ensurePgJobTable();
  await pgEnqueue(queue, name, payload, opts);
}

export async function enqueueDiscoveryJob(sourceId: string, actorId?: string): Promise<void> {
  // Dedupe per minute per source across drivers.
  const jobId = `ingest:${sourceId}:${Math.floor(Date.now() / 60_000)}`;
  await enqueueJob(QUEUE_NAMES.discovery, "ingest-source", { sourceId, actorId }, { jobId });
}

export async function scheduleOperationsSweep(): Promise<void> {
  const d = await detectDriver();
  if (d === "bullmq") {
    const { getQueue } = await import("./queues");
    // BullMQ 6: repeatable jobs via upsertJobScheduler
    await getQueue(QUEUE_NAMES.operations).upsertJobScheduler("operations-sweep", { every: 5 * 60_000 }, {
      name: "sweep",
      data: {},
    });
    await getQueue(QUEUE_NAMES.operations).upsertJobScheduler("payments-reconcile", { every: 5 * 60_000 }, {
      name: "payments-reconcile",
      data: {},
    });
    return;
  }
  await ensurePgJobTable();
  await pgScheduleRecurring(QUEUE_NAMES.operations, "sweep", {}, 5 * 60_000);
  await pgScheduleRecurring(QUEUE_NAMES.operations, "payments-reconcile", {}, 5 * 60_000);
}
