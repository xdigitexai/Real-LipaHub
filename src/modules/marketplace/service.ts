/**
 * Marketplace module — campaigns, tasks, applications, assignments,
 * submissions and reviews. All money-adjacent transitions are
 * transactional and journaled via the finance module.
 *
 * Tenant isolation: every business-side read is scoped by organizationId.
 */
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { reserveTaskFunds, releaseReservationBack, payRewardOnApproval, campaignHeldBalance } from "@/modules/finance";
import { audit } from "@/modules/audit";
import { runVerification } from "@/modules/verification";
import { notify } from "@/modules/notifications";
import { sha256 } from "@/lib/crypto";

// ── Campaigns ────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  organizationId: string;
  actorId: string;
  title: string;
  description: string;
  category: string;
  budgetMinor: bigint;
  currency?: string;
}

export function createCampaign(input: CreateCampaignInput) {
  if (input.title.trim().length < 4) throw Errors.badRequest("Campaign title too short");
  if (input.description.trim().length < 10) throw Errors.badRequest("Campaign description too short");
  if (input.budgetMinor <= 0n) throw Errors.badRequest("Budget must be positive");
  return prisma.campaign.create({
    data: {
      organizationId: input.organizationId,
      title: input.title.trim(),
      description: input.description.trim(),
      category: input.category.trim(),
      budgetMinor: input.budgetMinor,
      currency: input.currency ?? "KES",
    },
  });
}

export async function listCampaignsForOrg(organizationId: string) {
  return prisma.campaign.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { tasks: { select: { id: true, status: true, rewardMinor: true, slotsTotal: true, slotsTaken: true } } },
  });
}

export async function getCampaignForOrg(organizationId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.organizationId !== organizationId) throw Errors.notFound("Campaign not found");
  return campaign;
}

// ── Tasks ────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  campaignId: string;
  organizationId: string;
  actorId: string;
  title: string;
  instructions: string;
  deliverableSpec: string;
  category: string;
  rewardMinor: bigint;
  slotsTotal: number;
  geoAllow?: string[];
  skillsRequired?: string[];
  evidenceRequirements?: string[];
}

export async function createTask(input: CreateTaskInput) {
  if (input.title.trim().length < 4) throw Errors.badRequest("Task title too short");
  if (input.instructions.trim().length < 10) throw Errors.badRequest("Task instructions too short");
  if (input.deliverableSpec.trim().length < 5) throw Errors.badRequest("Deliverable spec too short");
  if (input.rewardMinor <= 0n) throw Errors.badRequest("Reward must be positive");
  if (!Number.isInteger(input.slotsTotal) || input.slotsTotal < 1 || input.slotsTotal > 1000) {
    throw Errors.badRequest("Slots must be between 1 and 1000");
  }
  await getCampaignForOrg(input.organizationId, input.campaignId);
  return prisma.task.create({
    data: {
      campaignId: input.campaignId,
      title: input.title.trim(),
      instructions: input.instructions.trim(),
      deliverableSpec: input.deliverableSpec.trim(),
      category: input.category.trim(),
      rewardMinor: input.rewardMinor,
      slotsTotal: input.slotsTotal,
      geoAllow: input.geoAllow ?? ["*"],
      skillsRequired: input.skillsRequired ?? [],
      evidenceRequirements: input.evidenceRequirements ?? ["File or screenshot proving completion"],
    },
  });
}

/**
 * Publish a task. Payable tasks REQUIRE the campaign to be funded:
 * reward × slots is reserved from campaign held funds in the same
 * transaction (escrow). Draft tasks without reward stay free.
 */
export async function publishTask(input: { taskId: string; organizationId: string; actorId: string }) {
  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: input.taskId }, include: { campaign: true } });
    if (!task) throw Errors.notFound("Task not found");
    if (task.campaign.organizationId !== input.organizationId) throw Errors.forbidden("Task belongs to another organization");
    if (task.status !== "DRAFT" && task.status !== "PENDING_FUNDING") {
      throw Errors.conflict(`Task is ${task.status}; only DRAFT tasks can be published`);
    }

    const amount = task.rewardMinor * BigInt(task.slotsTotal);
    if (amount > 0n) {
      if (task.campaign.status === "DRAFT") throw Errors.unprocessable("Campaign must be funded before publishing payable tasks");
      const held = await campaignHeldBalance(tx, task.campaignId);
      if (held < amount) {
        throw Errors.unprocessable(
          `Insufficient campaign funds: available ${held} minor units, need ${amount}. Fund the campaign.`,
        );
      }
      const { reservationId } = await reserveTaskFunds(tx, {
        taskId: task.id,
        campaignId: task.campaignId,
        amountMinor: amount,
        actorId: input.actorId,
      });
      await tx.task.update({
        where: { id: task.id },
        data: { status: "OPEN", publishedAt: new Date() },
      });
      return { published: true, reservationId, taskId: task.id };
    }

    // Non-payable listing (reward == 0 not allowed for marketplace work,
    // but keep the branch explicit and auditable).
    throw Errors.badRequest("Task reward must be greater than zero");
  });

  await audit({
    actorId: input.actorId,
    actorRole: "BUSINESS",
    action: "marketplace.task_published",
    entityType: "task",
    entityId: input.taskId,
    metadata: result,
  });
  return result;
}

export async function cancelTask(input: { taskId: string; organizationId: string; actorId: string }) {
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: input.taskId }, include: { reservations: true } });
    if (!task) throw Errors.notFound("Task not found");
    const campaign = await tx.campaign.findUnique({ where: { id: task.campaignId } });
    if (!campaign || campaign.organizationId !== input.organizationId) throw Errors.forbidden("Task belongs to another organization");
    if (task.status === "COMPLETED" || task.status === "CANCELLED") throw Errors.conflict("Task already closed");
    const activeAssignments = await tx.assignment.count({
      where: { taskId: task.id, status: { in: ["ACTIVE", "SUBMITTED", "IN_REVIEW"] } },
    });
    if (activeAssignments > 0) throw Errors.conflict("Task has active assignments; resolve them first");

    const reservation = task.reservations.find((r) => r.status === "HELD");
    if (reservation) {
      await releaseReservationBack(tx, { reservationId: reservation.id, actorId: input.actorId });
    }
    await tx.task.update({ where: { id: task.id }, data: { status: "CANCELLED" } });
    await tx.application.updateMany({ where: { taskId: task.id, status: "PENDING" }, data: { status: "REJECTED" } });
  });
  await audit({ actorId: input.actorId, actorRole: "BUSINESS", action: "marketplace.task_cancelled", entityType: "task", entityId: input.taskId });
}

// ── Applications ─────────────────────────────────────────────────────

export async function applyToTask(input: { taskId: string; workerId: string; message?: string }) {
  const task = await prisma.task.findUnique({ where: { id: input.taskId } });
  if (!task || !["OPEN", "IN_PROGRESS"].includes(task.status)) {
    throw Errors.conflict("Task is not open for applications");
  }
  if (task.slotsTaken >= task.slotsTotal) throw Errors.conflict("Task is fully assigned");

  const worker = await prisma.workerProfile.findUnique({ where: { userId: input.workerId } });
  if (!worker) throw Errors.forbidden("Only workers can apply");

  const existing = await prisma.application.findUnique({
    where: { taskId_workerId: { taskId: input.taskId, workerId: input.workerId } },
  });
  if (existing && ["PENDING", "ACCEPTED"].includes(existing.status)) throw Errors.conflict("You have already applied to this task");

  if (existing) {
    return prisma.application.update({
      where: { id: existing.id },
      data: { status: "PENDING", message: input.message?.slice(0, 2000) },
    });
  }
  return prisma.application.create({
    data: {
      taskId: input.taskId,
      workerId: input.workerId,
      message: input.message?.slice(0, 2000),
    },
  });
}

export async function listApplicationsForOrgTask(organizationId: string, taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { campaign: true } });
  if (!task || task.campaign.organizationId !== organizationId) throw Errors.notFound("Task not found");
  return prisma.application.findMany({
    where: { taskId, status: "PENDING" },
    include: { worker: { select: { id: true, name: true, email: true, workerProfile: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function decideApplication(input: {
  applicationId: string;
  organizationId: string;
  actorId: string;
  accept: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    const application = await tx.application.findUnique({
      where: { id: input.applicationId },
      include: { task: { include: { campaign: true, reservations: true } },
      },
    });
    if (!application) throw Errors.notFound("Application not found");
    if (application.task.campaign.organizationId !== input.organizationId) throw Errors.forbidden("Application belongs to another organization");
    if (application.status !== "PENDING") throw Errors.conflict(`Application already ${application.status}`);

    if (!input.accept) {
      await tx.application.update({ where: { id: application.id }, data: { status: "REJECTED" } });
      return { accepted: false, assignmentId: null };
    }

    if (application.task.slotsTaken >= application.task.slotsTotal) throw Errors.conflict("Task is fully assigned");

    const assignment = await tx.assignment.create({
      data: {
        taskId: application.taskId,
        workerId: application.workerId,
        applicationId: application.id,
        status: "ACTIVE",
        deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    await tx.application.update({ where: { id: application.id }, data: { status: "ACCEPTED" } });
    await tx.task.update({
      where: { id: application.taskId },
      data: { slotsTaken: { increment: 1 }, status: "IN_PROGRESS" },
    });

    await notify({
      userId: application.workerId,
      type: "assignment.created",
      title: "You have been assigned a task",
      body: `You were accepted for "${application.task.title}". Review the instructions and submit before the deadline.`,
      link: `/worker/assignments/${assignment.id}`,
    });
    return { accepted: true, assignmentId: assignment.id };
  });
}

// ── Submissions ──────────────────────────────────────────────────────

export interface EvidenceItem {
  kind: "text" | "link" | "file";
  label?: string;
  value: string;
}

export interface SubmitWorkInput {
  assignmentId: string;
  workerId: string;
  notes?: string;
  evidence: EvidenceItem[];
}

export async function submitWork(input: SubmitWorkInput) {
  if (!input.evidence || input.evidence.length === 0) throw Errors.badRequest("At least one evidence item is required");
  for (const item of input.evidence) {
    if (!item.value || item.value.trim().length === 0) throw Errors.badRequest("Evidence items cannot be empty");
    if (item.kind === "link" && !/^https?:\/\/.+\..+/.test(item.value)) {
      throw Errors.badRequest(`Evidence link is not a valid URL: ${item.label ?? item.value.slice(0, 50)}`);
    }
    if (item.value.length > 5000) throw Errors.badRequest("Evidence item too long");
  }

  const normalized = input.evidence.map((e) => ({ kind: e.kind, label: e.label ?? "", value: e.value.trim() }));
  const contentHash = sha256(JSON.stringify(normalized.map((e) => `${e.kind}:${e.value.toLowerCase()}`)));

  const result = await prisma.$transaction(async (tx) => {
    const assignment = await tx.assignment.findUnique({
      where: { id: input.assignmentId },
      include: { task: { include: { campaign: true } } },
    });
    if (!assignment) throw Errors.notFound("Assignment not found");
    if (assignment.workerId !== input.workerId) throw Errors.forbidden("This assignment belongs to another worker");
    if (assignment.status !== "ACTIVE") throw Errors.conflict(`Assignment is ${assignment.status}; only ACTIVE assignments accept submissions`);

    const submission = await tx.submission.create({
      data: {
        assignmentId: assignment.id,
        notes: input.notes?.slice(0, 4000),
        evidence: normalized as never,
        contentHash,
        status: "PENDING",
      },
    });

    await tx.assignment.update({ where: { id: assignment.id }, data: { status: "SUBMITTED" } });

    // Deterministic verification pipeline runs synchronously (fast checks);
    // AI verification is async via queue when configured.
    const verdict = await runVerification(tx, {
      submissionId: submission.id,
      workerId: input.workerId,
      evidenceRequirements: assignment.task.evidenceRequirements,
    });

    return { submissionId: submission.id, verdict };
  });

  await audit({
    actorId: input.workerId,
    actorRole: "WORKER",
    action: "marketplace.work_submitted",
    entityType: "submission",
    entityId: result.submissionId,
    metadata: { verdict: result.verdict.verdict, confidence: result.verdict.confidence },
  });
  return result;
}

// ── Business review ──────────────────────────────────────────────────

export async function listSubmissionsForOrg(organizationId: string, status?: string) {
  return prisma.submission.findMany({
    where: {
      assignment: { task: { campaign: { organizationId } } },
      ...(status ? { status: status as never } : {}),
    },
    include: {
      assignment: {
        include: {
          worker: { select: { id: true, name: true, email: true } },
          task: { select: { id: true, title: true, rewardMinor: true, campaign: { select: { title: true } } } },
        },
      },
      verificationRuns: { orderBy: { createdAt: "desc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function reviewSubmission(input: {
  submissionId: string;
  organizationId: string;
  actorId: string;
  approve: boolean;
  reason?: string;
}) {
  const payout = await prisma.$transaction(async (tx) => {
    const submission = await tx.submission.findUnique({
      where: { id: input.submissionId },
      include: {
        assignment: { include: { task: { include: { campaign: true, reservations: true } } } },
      },
    });
    if (!submission) throw Errors.notFound("Submission not found");
    if (submission.assignment.task.campaign.organizationId !== input.organizationId) {
      throw Errors.forbidden("Submission belongs to another organization");
    }
    const assignment = submission.assignment;
    if (!["SUBMITTED", "IN_REVIEW"].includes(assignment.status)) {
      throw Errors.conflict(`Assignment is ${assignment.status}; nothing to review`);
    }

    if (!input.approve) {
      const reason = input.reason?.trim();
      if (!reason || reason.length < 5) throw Errors.badRequest("A rejection explanation (min 5 chars) is required");
      await tx.submission.update({ where: { id: submission.id }, data: { status: "REJECTED" } });
      await tx.assignment.update({ where: { id: assignment.id }, data: { status: "REJECTED" } });
      await notify({
        userId: assignment.workerId,
        type: "submission.rejected",
        title: "Submission rejected",
        body: `Your submission for "${assignment.task.title}" was rejected. Reason: ${reason}`,
        link: `/worker/assignments/${assignment.id}`,
      });
      return { approved: false, workerMinor: 0n, commissionMinor: 0n };
    }

    const reservation = assignment.task.reservations.find((r) => r.status === "HELD");
    if (!reservation) throw Errors.unprocessable("No held reservation for this task; cannot pay");

    const result = await payRewardOnApproval(tx, {
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      workerId: assignment.workerId,
      reservationId: reservation.id,
      amountMinor: assignment.task.rewardMinor,
      actorId: input.actorId,
    });

    await tx.submission.update({ where: { id: submission.id }, data: { status: "APPROVED" } });
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { status: "APPROVED", approvedAt: new Date(), payoutMinor: result.workerMinor },
    });

    const task = await tx.task.findUnique({ where: { id: assignment.taskId } });
    if (task && task.slotsTaken >= task.slotsTotal) {
      await tx.task.update({ where: { id: task.id }, data: { status: "COMPLETED" } });
    }

    await notify({
      userId: assignment.workerId,
      type: "submission.approved",
      title: "Submission approved — reward recorded",
      body: `Your work on "${assignment.task.title}" was approved. ${result.workerMinor} minor units were added to your reward ledger.`,
      link: "/worker/rewards",
    });

    return { approved: true, workerMinor: result.workerMinor, commissionMinor: result.commissionMinor };
  });

  await audit({
    actorId: input.actorId,
    actorRole: "BUSINESS",
    action: payout.approved ? "marketplace.submission_approved" : "marketplace.submission_rejected",
    entityType: "submission",
    entityId: input.submissionId,
    metadata: { payoutMinor: payout.workerMinor.toString(), commissionMinor: payout.commissionMinor.toString() },
  });
  return payout;
}

// ── Worker views ─────────────────────────────────────────────────────

export async function listWorkerAssignments(workerId: string) {
  return prisma.assignment.findMany({
    where: { workerId },
    include: {
      task: { select: { id: true, title: true, instructions: true, deliverableSpec: true, rewardMinor: true, evidenceRequirements: true, campaign: { select: { title: true, organization: { select: { name: true } } } } } },
      submissions: { orderBy: { createdAt: "desc" }, include: { verificationRuns: { orderBy: { createdAt: "desc" } } } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWorkerAssignment(workerId: string, assignmentId: string) {
  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    include: {
      task: { include: { campaign: { select: { title: true, organization: { select: { name: true } } } } } },
      submissions: { include: { verificationRuns: { orderBy: { createdAt: "desc" } } } },
    },
  });
  if (!assignment || assignment.workerId !== workerId) throw Errors.notFound("Assignment not found");
  return assignment;
}

export async function listOpenTasks(filters?: { category?: string; search?: string }) {
  return prisma.task.findMany({
    where: {
      // OPEN (no assignments yet) and IN_PROGRESS (slots still available)
      status: { in: ["OPEN", "IN_PROGRESS"] },
      ...(filters?.category ? { category: filters.category } : {}),
      ...(filters?.search ? { title: { contains: filters.search, mode: "insensitive" } } : {}),
    },
    include: { campaign: { select: { title: true, organization: { select: { name: true } } } } },
    orderBy: { publishedAt: "desc" },
    take: 100,
  });
}
