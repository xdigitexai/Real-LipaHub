/**
 * BullMQ queue definitions. The web app enqueues; the worker process
 * consumes. Queue names are stable identifiers shared by both.
 */
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const QUEUE_NAMES = {
  discovery: "discovery",
  evaluation: "evaluation",
  verification: "verification",
  operations: "operations",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

type ConnFactory = () => Redis;
let connectionFactory: ConnFactory | null = null;

/** Injected by the runtime (lib/redis) to avoid double connections in tests. */
export function setQueueConnectionFactory(factory: ConnFactory): void {
  connectionFactory = factory;
}

const queues = new Map<string, Queue>();

export function getQueue(name: QueueName): Queue {
  if (!connectionFactory) {
    // Lazy import default connection
    const { getRedis } = require("@/lib/rate-limit") as typeof import("@/lib/rate-limit");
    setQueueConnectionFactory(() => getRedis());
  }
  const factory = connectionFactory!;
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: factory(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
    queues.set(name, q);
  }
  return q;
}

export interface DiscoveryJobData {
  sourceId: string;
  actorId?: string;
}

export async function enqueueDiscovery(data: DiscoveryJobData): Promise<void> {
  await getQueue(QUEUE_NAMES.discovery).add("ingest-source", data, {
    jobId: `ingest:${data.sourceId}:${Math.floor(Date.now() / 60_000)}`, // dedupe per minute
  });
}
