import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { Errors } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/payments/[reference]/status — authenticated status polling for
 * the business UI while an STK push / hosted checkout is in flight.
 * Only the initiating organization (or an admin) may read a deposit record.
 * This endpoint NEVER credits anything; it only reports internal state.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ reference: string }> }) {
  const auth = await getAuthContext();
  if (!auth) throw Errors.unauthorized();
  const { reference } = await ctx.params;

  const record = await prisma.paymentRecord.findUnique({
    where: { internalRef: reference },
  });
  if (!record) {
    // Also allow looking up by provider reference (client only ever gets internalRef).
    const byProvider = await prisma.paymentRecord.findUnique({ where: { providerRef: reference } });
    if (!byProvider) throw Errors.notFound("Payment not found");
    return scoped(auth, byProvider);
  }
  return scoped(auth, record);
}

function scoped(
  auth: { role: string; organizationId?: string; userId: string },
  record: { kind: string; organizationId: string | null; workerId: string | null; status: string; gateway: string | null; failureReason: string | null; amountMinor: bigint; feeMinor: bigint; netMinor: bigint | null; currency: string; internalRef: string; providerRef: string | null; createdAt: Date },
) {
  const isOwnerOrg = record.kind === "DEPOSIT" && record.organizationId === auth.organizationId;
  const isOwnerWorker = record.kind === "WITHDRAWAL" && record.workerId === auth.userId;
  if (!(auth.role === "ADMIN" || isOwnerOrg || isOwnerWorker)) throw Errors.forbidden();

  return NextResponse.json({
    internalRef: record.internalRef,
    providerRef: record.providerRef,
    kind: record.kind,
    status: record.status,
    gateway: record.gateway,
    amountMinor: record.amountMinor.toString(),
    feeMinor: record.feeMinor.toString(),
    netMinor: record.netMinor?.toString() ?? null,
    currency: record.currency,
    failureReason: record.failureReason,
    createdAt: record.createdAt,
  });
}
