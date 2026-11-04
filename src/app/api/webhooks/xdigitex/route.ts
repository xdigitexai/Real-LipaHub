import { NextResponse } from "next/server";
import { processWebhook } from "@/modules/payments/service";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/xdigitex
 *
 * Security model (provider publishes NO signature scheme — verified):
 *  1. If XDIGITEX_PAY_WEBHOOK_SECRET is configured, the request must carry
 *     the matching X-Webhook-Secret header (our convention).
 *  2. Regardless: the payload is NEVER trusted — the referenced payment is
 *     verified against GET /payments/{reference}/status before any ledger
 *     movement. Unknown/mismatched references are rejected and audited.
 *  3. Duplicate deliveries are idempotent (already-final records ignored).
 */
export async function POST(req: Request) {
  if (!(await rateLimit("webhook:xdigitex", 120, 60))) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const secretHeader = req.headers.get("x-webhook-secret");
  const secretOk = env.xdigitex.webhookSecret ? secretHeader === env.xdigitex.webhookSecret : true;
  const eventType = typeof body.event === "string" ? body.event : typeof body.type === "string" ? body.type : "unknown";

  try {
    const outcome = await processWebhook({
      eventType,
      payload: body,
      ip: req.headers.get("x-forwarded-for") ?? undefined,
      secretOk,
    });
    logger.info("webhook_processed", { event: eventType, status: outcome.status, outcome: outcome.outcome.slice(0, 120) });
    // 200 for processed/ignored/rejected — provider should stop retrying only
    // on processed; rejected/failed return 200 with outcome details so the
    // delivery is audited but genuine provider retries are still possible
    // for FAILED verification (e.g. our status call timed out).
    const httpStatus = outcome.status === "FAILED" ? 202 : 200;
    return NextResponse.json({ ok: true, status: outcome.status, outcome: outcome.outcome }, { status: httpStatus });
  } catch (e) {
    logger.error("webhook_error", { error: String(e).slice(0, 300) });
    return NextResponse.json({ ok: false, error: "processing error" }, { status: 500 });
  }
}
