import Redis from "ioredis";
import { env } from "./env";

const globalForRedis = globalThis as unknown as { redis?: Redis };

export function getRedis(): Redis {
  if (!globalForRedis.redis) {
    const client = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      enableOfflineQueue: false,
      retryStrategy: () => null, // no endless reconnect spam when Redis is absent
    });
    client.on("error", () => {
      /* handled: rate limiting fails open when Redis is unreachable */
    });
    globalForRedis.redis = client;
  }
  return globalForRedis.redis;
}

/** Token-bucket rate limit. Returns true when allowed. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  let redis: Redis;
  try {
    redis = getRedis();
  } catch {
    // Redis unavailable — fail open but never silently in prod logs
    return true;
  }
  const bucket = `rl:${key}`;
  const now = Date.now();
  const windowMs = windowSec * 1000;
  try {
    const [, count] = await redis
      .multi()
      .zremrangebyscore(bucket, 0, now - windowMs)
      .zcard(bucket)
      .exec()
      .then((r) => {
        const arr = r ?? [];
        return [arr[0], (arr[1]?.[1] as number) ?? 0] as const;
      });
    if (count >= limit) return false;
    await redis.zadd(bucket, now, `${now}:${Math.random().toString(36).slice(2)}`);
    await redis.pexpire(bucket, windowMs);
    return true;
  } catch {
    return true; // fail open when Redis is down
  }
}
