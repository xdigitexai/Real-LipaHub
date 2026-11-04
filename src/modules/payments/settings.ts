/**
 * Platform settings — non-secret runtime configuration editable by admins.
 * The provider API key is NOT stored here (env-only, never rendered).
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

export interface WithdrawalPolicy {
  minMinor: bigint;
  maxMinor: bigint;
}

const KEYS = {
  minWithdrawalMinor: "withdrawal.min_minor",
  maxWithdrawalMinor: "withdrawal.max_minor",
  enabledGateways: "payments.enabled_gateways",
  recommendedGateway: "payments.recommended_gateway",
} as const;

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSettings(entries: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await prisma.platformSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
}

export async function getWithdrawalPolicy(): Promise<WithdrawalPolicy> {
  const [min, max] = await Promise.all([
    getSetting(KEYS.minWithdrawalMinor),
    getSetting(KEYS.maxWithdrawalMinor),
  ]);
  return {
    minMinor: BigInt(min ?? env.withdrawals.minMinor),
    maxMinor: BigInt(max ?? env.withdrawals.maxMinor),
  };
}

export async function getEnabledGateways(): Promise<string[]> {
  const v = await getSetting(KEYS.enabledGateways);
  if (!v) return ["safaricom", "airtel", "card", "mobile", "crypto"];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function getRecommendedGateway(): Promise<string> {
  return (await getSetting(KEYS.recommendedGateway)) ?? "safaricom";
}

export function settingKeys() {
  return KEYS;
}

/** Masked provider config for the admin UI — the API key is NEVER included. */
export async function getProviderConfigStatus(): Promise<{
  configured: boolean;
  baseUrl: string;
  webhookSecretSet: boolean;
  appPublicUrl: string;
}> {
  const { isXdigitexConfigured } = await import("./xdigitex");
  return {
    configured: isXdigitexConfigured(),
    baseUrl: env.xdigitex.baseUrl,
    webhookSecretSet: env.xdigitex.webhookSecret.length > 0,
    appPublicUrl: env.appPublicUrl,
  };
}
