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

  const aiConfigured = Boolean(process.env.LIPAHUB_AI_API_KEY);
  checks.ai = { status: aiConfigured ? "configured" : "not-configured", note: aiConfigured ? undefined : "agents fall back to deterministic + human review" };

  return NextResponse.json({ status: ok ? "healthy" : "unhealthy", ts: new Date().toISOString(), checks }, { status: ok ? 200 : 503 });
}
