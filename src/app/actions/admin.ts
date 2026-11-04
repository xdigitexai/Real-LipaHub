"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/session-server";
import { approveWithdrawal, rejectWithdrawal } from "@/modules/finance";
import { Errors } from "@/lib/errors";

export async function adminWithdrawalDecisionAction(formData: FormData): Promise<void> {
  const ctx = await getAuthContext();
  if (!ctx || ctx.role !== "ADMIN") throw Errors.forbidden();
  const id = String(formData.get("withdrawalId"));
  const decision = String(formData.get("decision"));
  if (decision === "approve") {
    await approveWithdrawal({ withdrawalId: id, adminId: ctx.userId });
  } else {
    await rejectWithdrawal({
      withdrawalId: id,
      adminId: ctx.userId,
      note: String(formData.get("note") ?? "Rejected by administrator"),
    });
  }
  revalidatePath("/admin/withdrawals");
  revalidatePath("/admin/ledger");
}

export async function escalateSubmissionAction(formData: FormData): Promise<void> {
  // Human decision on an escalated (NEEDS_REVIEW) submission.
  const ctx = await getAuthContext();
  if (!ctx || ctx.role !== "ADMIN") throw Errors.forbidden();
  const { prisma } = await import("@/lib/db");
  const { recordHumanVerification } = await import("@/modules/verification");
  const submissionId = String(formData.get("submissionId"));
  const verdict = String(formData.get("decision")) === "pass" ? "PASS" : "FAIL";
  await recordHumanVerification({
    submissionId,
    reviewerId: ctx.userId,
    verdict: verdict as "PASS" | "FAIL",
    note: String(formData.get("note") ?? ""),
  });
  if (verdict === "PASS") {
    await prisma.submission.update({ where: { id: submissionId }, data: { status: "AUTO_VERIFIED" } });
  } else {
    await prisma.submission.update({ where: { id: submissionId }, data: { status: "REJECTED" } });
  }
  revalidatePath("/admin/verifications");
}
