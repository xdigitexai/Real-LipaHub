"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/session-server";
import { requireVerifiedOrg } from "@/modules/identity";
import {
  createCampaign, createTask, publishTask, cancelTask,
  applyToTask, decideApplication, reviewSubmission, submitWork,
} from "@/modules/marketplace";
import { fundCampaign, requestWithdrawal } from "@/modules/finance";
import { enqueueDiscoveryJob } from "@/jobs/enqueue";
import { addManualListing } from "@/modules/opportunities";
import { toMinor } from "@/lib/money";
import { Errors } from "@/lib/errors";
import type { ActionState } from "@/app/actions/auth";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Action failed";
}

// ── Business actions ─────────────────────────────────────────────────

export async function createCampaignAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  let campaignId: string | null = null;
  try {
    const ctx = await getAuthContext();
    const org = await requireVerifiedOrg(ctx);
    const campaign = await createCampaign({
      organizationId: org.id,
      actorId: ctx!.userId,
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      category: String(formData.get("category") ?? "other"),
      budgetMinor: toMinor(Number(formData.get("budget"))),
    });
    campaignId = campaign.id;
  } catch (e) {
    return { error: errMsg(e) };
  }
  revalidatePath("/business");
  redirect(`/business/campaigns/${campaignId}`);
}

export async function fundCampaignAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    const org = await requireVerifiedOrg(ctx);
    const idem = `fund-${String(formData.get("campaignId"))}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fundCampaign({
      organizationId: org.id,
      campaignId: String(formData.get("campaignId")),
      amountMinor: toMinor(Number(formData.get("amount"))),
      idempotencyKey: idem,
      payer: String(formData.get("payer") ?? "254700000000"),
      actorId: ctx!.userId,
    });
    revalidatePath(`/business/campaigns/${String(formData.get("campaignId"))}`);
    revalidatePath("/business");
    return { success: "Funding confirmed (sandbox M-Pesa). Ledger updated." };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function createTaskAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    const org = await requireVerifiedOrg(ctx);
    const task = await createTask({
      campaignId: String(formData.get("campaignId")),
      organizationId: org.id,
      actorId: ctx!.userId,
      title: String(formData.get("title") ?? ""),
      instructions: String(formData.get("instructions") ?? ""),
      deliverableSpec: String(formData.get("deliverableSpec") ?? ""),
      category: String(formData.get("category") ?? "microtask"),
      rewardMinor: toMinor(Number(formData.get("reward"))),
      slotsTotal: Number(formData.get("slots") ?? 1),
      evidenceRequirements: String(formData.get("evidenceRequirements") ?? "")
        .split("\n").map((s) => s.trim()).filter(Boolean),
    });
    revalidatePath(`/business/campaigns/${String(formData.get("campaignId"))}`);
    return { success: `Task created (${task.id.slice(0, 8)}…). Publish it to reserve funds.` };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function publishTaskAction(formData: FormData): Promise<void> {
  "use server";
  const ctx = await getAuthContext();
  const org = await requireVerifiedOrg(ctx);
  await publishTask({ taskId: String(formData.get("taskId")), organizationId: org.id, actorId: ctx!.userId });
  revalidatePath(`/business/campaigns/${String(formData.get("campaignId"))}`);
  revalidatePath("/business");
}

export async function cancelTaskAction(formData: FormData): Promise<void> {
  "use server";
  const ctx = await getAuthContext();
  const org = await requireVerifiedOrg(ctx);
  await cancelTask({ taskId: String(formData.get("taskId")), organizationId: org.id, actorId: ctx!.userId });
  revalidatePath(`/business/campaigns/${String(formData.get("campaignId"))}`);
}

export async function decideApplicationAction(formData: FormData): Promise<void> {
  "use server";
  const ctx = await getAuthContext();
  const org = await requireVerifiedOrg(ctx);
  await decideApplication({
    applicationId: String(formData.get("applicationId")),
    organizationId: org.id,
    actorId: ctx!.userId,
    accept: String(formData.get("decision")) === "accept",
  });
  revalidatePath(`/business/tasks/${String(formData.get("taskId"))}`);
}

export async function reviewSubmissionAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    const org = await requireVerifiedOrg(ctx);
    const approve = String(formData.get("decision")) === "approve";
    const payout = await reviewSubmission({
      submissionId: String(formData.get("submissionId")),
      organizationId: org.id,
      actorId: ctx!.userId,
      approve,
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath("/business/reviews");
    revalidatePath("/business");
    return approve
      ? { success: `Approved — ${(Number(payout.workerMinor) / 100).toFixed(2)} released to the worker ledger (${(Number(payout.commissionMinor) / 100).toFixed(2)} commission).` }
      : { success: "Submission rejected with explanation sent to the worker." };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

// ── Worker actions ───────────────────────────────────────────────────

export async function applyToTaskAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    if (!ctx || ctx.role !== "WORKER") throw Errors.forbidden("Only workers can apply");
    await applyToTask({ taskId: String(formData.get("taskId")), workerId: ctx.userId, message: String(formData.get("message") ?? "") });
    revalidatePath("/worker");
    revalidatePath("/worker/discover");
    return { success: "Application sent. The business will review it." };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function submitWorkAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    if (!ctx || ctx.role !== "WORKER") throw Errors.forbidden("Only workers can submit work");
    const evidenceRaw = String(formData.get("evidence") ?? "").trim();
    if (!evidenceRaw) throw Errors.badRequest("Evidence is required — paste a link or describe the proof of work");
    const evidence = evidenceRaw
      .split("\n").map((line) => line.trim()).filter(Boolean)
      .map((line) => (/^https?:\/\//.test(line) ? { kind: "link" as const, label: "Submitted link", value: line } : { kind: "text" as const, label: "Note", value: line }));
    const result = await submitWork({
      assignmentId: String(formData.get("assignmentId")),
      workerId: ctx.userId,
      notes: String(formData.get("notes") ?? ""),
      evidence,
    });
    revalidatePath("/worker");
    revalidatePath(`/worker/assignments/${String(formData.get("assignmentId"))}`);
    return {
      success: `Submitted — verification verdict: ${result.verdict.verdict} (confidence ${result.verdict.confidence}%). The business will review it.`,
    };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function requestWithdrawalAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    if (!ctx || ctx.role !== "WORKER") throw Errors.forbidden("Only workers can request withdrawals");
    const idem = `wd-${ctx.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await requestWithdrawal({
      workerId: ctx.userId,
      amountMinor: toMinor(Number(formData.get("amount"))),
      destination: String(formData.get("destination") ?? ""),
      idempotencyKey: idem,
    });
    revalidatePath("/worker/rewards");
    return { success: "Withdrawal request submitted — an administrator will review it." };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

// ── Admin actions ────────────────────────────────────────────────────

export async function moderateOpportunityAction(formData: FormData): Promise<void> {
  "use server";
  const ctx = await getAuthContext();
  if (!ctx || ctx.role !== "ADMIN") throw Errors.forbidden();
  const { moderateOpportunity } = await import("@/modules/opportunities");
  await moderateOpportunity({
    opportunityId: String(formData.get("opportunityId")),
    adminId: ctx.userId,
    approve: String(formData.get("decision")) === "approve",
    note: String(formData.get("note") ?? ""),
  });
  revalidatePath("/admin/opportunities/moderation");
  revalidatePath("/admin/opportunities/catalogue");
}

export async function createSourceAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    if (!ctx || ctx.role !== "ADMIN") throw Errors.forbidden();
    const { createSource } = await import("@/modules/opportunities");
    await createSource({
      name: String(formData.get("name") ?? ""),
      kind: String(formData.get("kind") ?? "RSS") as "RSS" | "HTML" | "API" | "MANUAL",
      url: String(formData.get("url") ?? "") || undefined,
      trustLevel: (String(formData.get("trustLevel") ?? "NEUTRAL") as "UNTRUSTED" | "NEUTRAL" | "TRUSTED"),
    });
    revalidatePath("/admin/opportunities/sources");
    return { success: "Source created." };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function triggerDiscoveryAction(formData: FormData): Promise<void> {
  "use server";
  const ctx = await getAuthContext();
  if (!ctx || ctx.role !== "ADMIN") throw Errors.forbidden();
  const sourceId = String(formData.get("sourceId"));
  const kind = String(formData.get("kind"));
  const { ingestSource } = await import("@/modules/opportunities");
  if (kind === "MANUAL") {
    // Manual sources ingest inline with admin-provided listing text
    await addManualListing({
      sourceId,
      title: String(formData.get("listingTitle") ?? ""),
      body: String(formData.get("listingBody") ?? ""),
      url: String(formData.get("listingUrl") ?? "") || undefined,
      actorId: ctx.userId,
    });
  } else {
    await enqueueDiscoveryJob(sourceId, ctx.userId);
  }
  revalidatePath("/admin/opportunities/sources");
  revalidatePath("/admin/opportunities/moderation");
}

export async function verifyOrganizationAction(formData: FormData): Promise<void> {
  "use server";
  const ctx = await getAuthContext();
  if (!ctx || ctx.role !== "ADMIN") throw Errors.forbidden();
  const { prisma } = await import("@/lib/db");
  const { audit } = await import("@/modules/audit");
  const orgId = String(formData.get("organizationId"));
  const decision = String(formData.get("decision")) === "verify" ? "VERIFIED" : "REJECTED";
  await prisma.organization.update({
    where: { id: orgId },
    data: {
      verificationStatus: decision,
      verificationNote: String(formData.get("note") ?? "") || null,
      verifiedAt: decision === "VERIFIED" ? new Date() : null,
    },
  });
  await audit({ actorId: ctx.userId, actorRole: "ADMIN", action: `admin.org_${decision.toLowerCase()}`, entityType: "organization", entityId: orgId });
  revalidatePath("/admin/users");
}
