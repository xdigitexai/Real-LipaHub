/**
 * LipaHub AI — environment configuration.
 * Single source of truth for runtime configuration. Secrets come from
 * process env only; they must never be embedded in client bundles.
 */
import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  databaseUrl: required("LIPAHUB_DATABASE_URL"),
  redisUrl: optional("LIPAHUB_REDIS_URL", "redis://localhost:6380"),
  appUrl: optional("LIPAHUB_APP_URL", "http://localhost:4310"),
  sessionTtlDays: int("LIPAHUB_SESSION_TTL_DAYS", 7),
  isProd: process.env.NODE_ENV === "production",

  ai: {
    provider: optional("LIPAHUB_AI_PROVIDER", "deepseek"),
    baseUrl: optional("LIPAHUB_AI_BASE_URL", "https://api.z.ai/api/paas/v4"),
    apiKey: optional("LIPAHUB_AI_API_KEY", ""),
    model: optional("LIPAHUB_AI_MODEL", "glm-5.3-flash"),
    timeoutMs: int("LIPAHUB_AI_TIMEOUT_MS", 45_000),
  },

  // DeepSeek — OpenAI-compatible provider (default for all agent purposes).
  // Key read from env at call time; never stored in DB, never logged.
  deepseek: {
    apiKey: optional("DEEPSEEK_API_KEY", ""),
    baseUrl: optional("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    timeoutMs: int("DEEPSEEK_TIMEOUT_MS", 60_000),
  },

  finance: {
    commissionBps: int("LIPAHUB_PLATFORM_COMMISSION_BPS", 1000),
    currency: optional("LIPAHUB_CURRENCY", "KES"),
  },

  xdigitex: {
    apiKey: optional("XDIGITEX_PAY_API_KEY", ""),
    baseUrl: optional("XDIGITEX_PAY_BASE_URL", "https://pay.xdigitex.space/api"),
    webhookSecret: optional("XDIGITEX_PAY_WEBHOOK_SECRET", ""),
    timeoutMs: int("XDIGITEX_PAY_TIMEOUT_MS", 30_000),
  },

  appPublicUrl: optional("APP_PUBLIC_URL", "http://localhost:4310"),

  withdrawals: {
    minMinor: int("LIPAHUB_MIN_WITHDRAWAL_MINOR", 1000),
    maxMinor: int("LIPAHUB_MAX_WITHDRAWAL_MINOR", 7_000_000),
  },

  storageDir: optional("LIPAHUB_STORAGE_DIR", "./storage"),
} as const;

export const SESSION_COOKIE = "lipahub_session";
