import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { detectDriver } from "@/jobs/enqueue";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: "up" };
  } catch (e) {
    ok = false;
    checks.database = { status: "down", error: String(e).slice(0, 120) };
  }

  try {
    const driver = await detectDriver();
    checks.queue = { status: "up", driver };
  } catch (e) {
    checks.queue = { status: "degraded", error: String(e).slice(0, 120) };
  }

  try {
    const { isModelConfigured, resolveModelConfig } = await import("@/modules/ai/adapter");
    const [aiConfigured, cfg] = await Promise.all([isModelConfigured(), resolveModelConfig("research")]);
    checks.ai = {
      status: aiConfigured ? "configured" : "not-configured",
      provider: cfg.provider,
      model: cfg.model,
      note: aiConfigured ? undefined : "agents fall back to deterministic + human review",
    };
  } catch (e) {
    checks.ai = { status: "error", error: String(e).slice(0, 120) };
  }

  // Provider config visibility (boolean only — the key itself is never exposed)
  checks.payments = { provider: "xdigitex", configured: Boolean(process.env.XDIGITEX_PAY_API_KEY) };

  return NextResponse.json({ status: ok ? "healthy" : "unhealthy", ts: new Date().toISOString(), checks }, { status: ok ? 200 : 503 });
}
