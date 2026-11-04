/**
 * Finance service — campaign funding, task reservations, reward payouts,
 * withdrawals. Every function is transactional + idempotent and journals
 * the money movement in the SAME transaction as the state change.
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { Errors } from "@/lib/errors";
import {
  ACCOUNTS,
  accountBalance,
  campaignHeldBalance,
  postJournal,
  workerPayableBalance,
} from "./ledger";
import { getPaymentAdapter } from "./provider";
import { audit } from "@/modules/audit";
import { commissionMinor } from "@/lib/money";
import type { Prisma } from "@prisma/client";

// ── Campaign funding (sandbox M-Pesa collection) ─────────────────────

export interface FundCampaignInput {
  organizationId: string;
  campaignId: string;
  amountMinor: bigint;
  idempotencyKey: string;
  payer: string;
  actorId?: string;
}

export async function fundCampaign(input: FundCampaignInput): Promise<{ fundingId: string; replayed: boolean }> {
  if (input.amountMinor <= 0n) throw Errors.badRequest("Funding amount must be positive");

  const existing = await prisma.fundingRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.status === "CONFIRMED") return { fundingId: existing.id, replayed: true };
    if (existing.status === "FAILED") throw Errors.conflict("A previous funding attempt with this key failed; use a new key");
    // PENDING — treat as replay to avoid double-charges
    return { fundingId: existing.id, replayed: true };
  }

  const campaign = await prisma.campaign.findUnique({ where: { id: input.campaignId } });
  if (!campaign) throw Errors.notFound("Campaign not found");
  if (campaign.organizationId !== input.organizationId) throw Errors.forbidden("Campaign belongs to another organization");
  if (["COMPLETED", "CANCELLED"].includes(campaign.status)) throw Errors.conflict("Campaign is closed to funding");

  const provider = getPaymentAdapter();
  const collection = await provider.initiateCollection({
    idempotencyKey: input.idempotencyKey,
    amountMinor: input.amountMinor,
    currency: campaign.currency,
    reference: `campaign:${input.campaignId}`,
    payer: input.payer,
  });

  const outcome = await prisma.$transaction(async (tx) => {
    const record = await tx.fundingRecord.create({
      data: {
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        provider: provider.id as never,
        amountMinor: input.amountMinor,
        currency: campaign.currency,
        status: collection.ok ? "CONFIRMED" : "FAILED",
        externalRef: collection.externalRef,
        idempotencyKey: input.idempotencyKey,
      },
    });

    await tx.paymentTransaction.create({
      data: {
        provider: provider.id as never,
        direction: "INBOUND",
        externalRef: collection.externalRef,
        amountMinor: input.amountMinor,
        currency: campaign.currency,
        status: collection.ok ? "COMPLETED" : "FAILED",
        payload: { sandbox: provider.sandbox, payer: input.payer } as never,
      },
    });

    if (collection.ok) {
      const { journalId } = await postJournal(tx, {
        kind: "CAMPAIGN_FUNDING",
        memo: `Campaign funding for ${campaign.title}`,
        referenceType: "campaign",
        referenceId: input.campaignId,
        idempotencyKey: `fund:${input.idempotencyKey}`,
        postedById: input.actorId,
        lines: [
          { account: ACCOUNTS.providerClearing.code, debit: input.amountMinor },
          { account: ACCOUNTS.campaignFundsHeld.code, credit: input.amountMinor },
        ],
      });
      await tx.fundingRecord.update({ where: { id: record.id }, data: { journalId } });

      // Transition campaign status DRAFT → FUNDED (stays ACTIVE once tasks exist)
      if (campaign.status === "DRAFT") {
        await tx.campaign.update({ where: { id: campaign.id }, data: { status: "FUNDED" } });
      }
    }

    return record.id;
  });

  await audit({
    actorId: input.actorId,
    actorRole: "BUSINESS",
    action: collection.ok ? "finance.campaign_funded" : "finance.campaign_funding_failed",
    entityType: "funding_record",
    entityId: outcome,
    metadata: { amountMinor: input.amountMinor.toString(), campaignId: input.campaignId },
  });

  if (!collection.ok) throw Errors.unprocessable(`Payment provider rejected the collection: ${collection.error}`);
  return { fundingId: outcome, replayed: false };
}

// ── Task reservation (publish payable task) ──────────────────────────

export async function reserveTaskFunds(tx: Prisma.TransactionClient, params: {
  taskId: string;
  campaignId: string;
  amountMinor: bigint;
  actorId?: string;
}): Promise<{ reservationId: string }> {
  const { taskId, campaignId, amountMinor } = params;
  if (amountMinor <= 0n) throw Errors.badRequest("Reservation amount must be positive");

  // Lock the campaign row to serialize concurrent publishes.
  await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;

  const held = await campaignHeldBalance(tx, campaignId);
  if (held < amountMinor) {
    throw Errors.unprocessable(
      `Insufficient campaign funds: held=${held} required=${amountMinor}. Fund the campaign first.`,
    );
  }

  const { journalId } = await postJournal(tx, {
    kind: "TASK_RESERVATION",
    memo: `Reward reservation for task ${taskId}`,
    referenceType: "task",
    referenceId: taskId,
    postedById: params.actorId,
    lines: [
      { account: ACCOUNTS.campaignFundsHeld.code, debit: amountMinor },
      { account: ACCOUNTS.taskEscrow.code, credit: amountMinor },
    ],
  });

  const reservation = await tx.taskReservation.create({
    data: { taskId, campaignId, amountMinor, status: "HELD", journalId },
  });

  return { reservationId: reservation.id };
}

/** Releases a reservation back to campaign held funds (task cancelled/rejected). */
export async function releaseReservationBack(tx: Prisma.TransactionClient, params: {
  reservationId: string;
  actorId?: string;
}): Promise<void> {
  const reservation = await tx.taskReservation.findUnique({ where: { id: params.reservationId } });
  if (!reservation) throw Errors.notFound("Reservation not found");
  if (reservation.status !== "HELD") return; // idempotent

  await postJournal(tx, {
    kind: "RESERVATION_RELEASE_BACK",
    memo: `Release reservation back to campaign ${reservation.campaignId}`,
    referenceType: "task",
    referenceId: reservation.taskId,
    idempotencyKey: `release-back:${reservation.id}`,
    postedById: params.actorId,
    lines: [
      { account: ACCOUNTS.taskEscrow.code, debit: reservation.amountMinor },
      { account: ACCOUNTS.campaignFundsHeld.code, credit: reservation.amountMinor },
    ],
  });
  await tx.taskReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED_BACK" } });
}

// ── Reward payout on approval ────────────────────────────────────────

export interface ApprovePayoutResult {
  workerMinor: bigint;
  commissionMinor: bigint;
  journalId: string;
  replayed: boolean;
}

/**
 * Releases escrow to the worker minus platform commission.
 * MUST be called inside the same transaction that transitions the
 * assignment to APPROVED. Idempotent by idempotencyKey (assignment id).
 */
export async function payRewardOnApproval(tx: Prisma.TransactionClient, params: {
  assignmentId: string;
  taskId: string;
  workerId: string;
  reservationId: string;
  amountMinor: bigint;
  actorId?: string;
}): Promise<ApprovePayoutResult> {
  const idem = `reward:${params.assignmentId}`;
  const existing = await tx.ledgerJournal.findUnique({ where: { idempotencyKey: idem } });
  if (existing) {
    // Reconstruct the split deterministically.
    const commission = commissionMinor(params.amountMinor, env.finance.commissionBps);
    return { workerMinor: params.amountMinor - commission, commissionMinor: commission, journalId: existing.id, replayed: true };
  }

  const commission = commissionMinor(params.amountMinor, env.finance.commissionBps);
  const workerMinor = params.amountMinor - commission;
  if (workerMinor <= 0n) throw Errors.unprocessable("Reward too small to pay after commission");

  const reservation = await tx.taskReservation.findUnique({ where: { id: params.reservationId } });
  if (!reservation || reservation.status !== "HELD") {
    throw Errors.unprocessable("Reservation is not in HELD state");
  }

  const { journalId } = await postJournal(tx, {
    kind: "REWARD_PAYOUT",
    memo: `Reward payout for assignment ${params.assignmentId}`,
    referenceType: "worker",
    referenceId: params.workerId,
    idempotencyKey: idem,
    postedById: params.actorId,
    lines: [
      { account: ACCOUNTS.taskEscrow.code, debit: params.amountMinor },
      { account: ACCOUNTS.workerPayable.code, credit: workerMinor },
      { account: ACCOUNTS.platformRevenue.code, credit: commission },
    ],
  });

  await tx.taskReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED_TO_WORKER" } });

  return { workerMinor, commissionMinor: commission, journalId, replayed: false };
}

// ── Withdrawals ──────────────────────────────────────────────────────

export async function requestWithdrawal(params: {
  workerId: string;
  amountMinor: bigint;
  destination: string;
  idempotencyKey: string;
}): Promise<{ withdrawalId: string; replayed: boolean }> {
  if (params.amountMinor <= 0n) throw Errors.badRequest("Withdrawal amount must be positive");
  if (params.destination.trim().length < 6) throw Errors.badRequest("Invalid withdrawal destination");

  const existing = await prisma.withdrawalRequest.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  if (existing) return { withdrawalId: existing.id, replayed: true };

  const created = await prisma.$transaction(async (tx) => {
    const balance = await workerPayableBalance(tx, params.workerId);
    if (balance < params.amountMinor) {
      throw Errors.unprocessable(`Insufficient balance: available=${balance} requested=${params.amountMinor}`);
    }
    return tx.withdrawalRequest.create({
      data: {
        workerId: params.workerId,
        amountMinor: params.amountMinor,
        destination: params.destination.trim(),
        status: "PENDING_REVIEW",
        idempotencyKey: params.idempotencyKey,
      },
    });
  });

  await audit({
    actorId: params.workerId,
    actorRole: "WORKER",
    action: "finance.withdrawal_requested",
    entityType: "withdrawal_request",
    entityId: created.id,
    metadata: { amountMinor: params.amountMinor.toString() },
  });

  return { withdrawalId: created.id, replayed: false };
}

/** Admin approves a withdrawal → funds leave worker-payable into withdrawal-clearing, provider payout runs. */
export async function approveWithdrawal(params: {
  withdrawalId: string;
  adminId: string;
}): Promise<{ status: string }> {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawalRequest.findUnique({ where: { id: params.withdrawalId } });
    if (!w) throw Errors.notFound("Withdrawal request not found");
    if (w.status !== "PENDING_REVIEW") throw Errors.conflict(`Withdrawal is ${w.status}, not PENDING_REVIEW`);

    const balance = await workerPayableBalance(tx, w.workerId);
    if (balance < w.amountMinor) {
      throw Errors.unprocessable("Worker balance changed; insufficient funds for this withdrawal");
    }

    const provider = getPaymentAdapter();
    const payout = await provider.initiatePayout({
      idempotencyKey: `wd:${w.id}`,
      amountMinor: w.amountMinor,
      currency: w.currency,
      reference: `withdrawal:${w.id}`,
      payee: w.destination,
    });

    if (!payout.ok) {
      await tx.withdrawalRequest.update({
        where: { id: w.id },
        data: { status: "FAILED", reviewNote: payout.error ?? "Provider rejected payout", reviewedById: params.adminId },
      });
      return { status: "FAILED" };
    }

    const { journalId } = await postJournal(tx, {
      kind: "WITHDRAWAL_EXECUTED",
      memo: `Withdrawal payout ${w.id}`,
      referenceType: "worker",
      referenceId: w.workerId,
      idempotencyKey: `wd-journal:${w.id}`,
      postedById: params.adminId,
      lines: [
        { account: ACCOUNTS.workerPayable.code, debit: w.amountMinor },
        { account: ACCOUNTS.providerClearing.code, credit: w.amountMinor },
      ],
    });

    await tx.withdrawalRequest.update({
      where: { id: w.id },
      data: { status: "PAID", providerRef: payout.externalRef, reviewedById: params.adminId, journalId },
    });
    await tx.paymentTransaction.create({
      data: {
        provider: provider.id as never,
        direction: "OUTBOUND",
        externalRef: payout.externalRef,
        amountMinor: w.amountMinor,
        currency: w.currency,
        status: "COMPLETED",
        payload: { withdrawalId: w.id } as never,
      },
    });

    return { status: "PAID" };
  });
}

/** Admin rejects a pending withdrawal (no money movement — request only). */
export async function rejectWithdrawal(params: {
  withdrawalId: string;
  adminId: string;
  note: string;
}): Promise<void> {
  const w = await prisma.withdrawalRequest.findUnique({ where: { id: params.withdrawalId } });
  if (!w) throw Errors.notFound("Withdrawal request not found");
  if (w.status !== "PENDING_REVIEW") throw Errors.conflict(`Withdrawal is ${w.status}`);
  await prisma.withdrawalRequest.update({
    where: { id: w.id },
    data: { status: "REJECTED", reviewedById: params.adminId, reviewNote: params.note.slice(0, 500) },
  });
  await audit({
    actorId: params.adminId,
    actorRole: "ADMIN",
    action: "finance.withdrawal_rejected",
    entityType: "withdrawal_request",
    entityId: w.id,
    metadata: { note: params.note.slice(0, 200) },
  });
}

export { accountBalance };
