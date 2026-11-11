/**
 * Payments service — Xdigitex Pay integration.
 *
 * HARD RULES (from the integration spec, enforced here):
 *  - An internal PaymentRecord is written BEFORE every provider call.
 *  - A successful initiation NEVER credits the ledger. Money moves only
 *    after authoritative verification via GET /payments/{ref}/status.
 *  - Webhook payloads are never trusted alone (no signature scheme is
 *    published). Duplicate deliveries are idempotent-safe.
 *  - Uncertain withdrawal outcomes are marked UNCERTAIN for admin review;
 *    they are never retried automatically (double-payout protection).
 *  - The internal ledger remains the source of truth for user balances;
 *    the provider wallet is only compared on the reconciliation page.
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { Errors } from "@/lib/errors";
import { randomId } from "@/lib/crypto";
import {
  ACCOUNTS,
  orgWalletBalance,
  workerPayableBalance,
  postJournal,
  fundCampaignFromWallet,
} from "@/modules/finance/ledger";
import { getPaymentAdapter } from "@/modules/finance/provider";
import { approveWithdrawal as legacyApproveWithdrawal } from "@/modules/finance/service";
import { audit } from "@/modules/audit";
import { getXdigitexClient, ProviderError, type XdigitexGateway, XDIGITEX_GATEWAYS, type ProviderPaymentStatus } from "./xdigitex";
import { getEnabledGateways, getWithdrawalPolicy } from "./settings";

export const WITHDRAWAL_FEE_PERCENT = 3.0; // documented by the provider
export const RECONCILE_MIN_AGE_MINUTES = 2;
export const WITHDRAWAL_UNCERTAIN_AFTER_MINUTES = 30;

const E164_RE = /^\+[1-9]\d{7,14}$/;
const PHONE_GATEWAYS: XdigitexGateway[] = ["safaricom", "airtel", "mobile"];

export function validatePhoneNumber(phone: string): string {
  const trimmed = phone.trim();
  if (!E164_RE.test(trimmed)) {
    throw Errors.badRequest("Phone must be in international format, e.g. +254712345678");
  }
  return trimmed;
}

export function withdrawalFeeMinor(amountMinor: bigint): bigint {
  // 3% rounded UP (provider-favourable, deterministic; actual fee is
  // confirmed by the provider response and stored on the record).
  const raw = (amountMinor * 3n) / 100n;
  return (amountMinor * 3n) % 100n === 0n ? raw : raw + 1n;
}

// ── Deposits (business wallet top-up) ────────────────────────────────

export interface InitiateDepositInput {
  organizationId: string;
  actorId: string;
  amountMinor: bigint;
  gateway: XdigitexGateway;
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  description?: string;
}

export interface DepositInstructions {
  internalRef: string;
  providerRef: string;
  kind: "stk" | "redirect" | "crypto";
  message?: string;
  redirectUrl?: string;
  checkoutUrl?: string;
  qrcodeLink?: string;
}

export async function initiateDeposit(input: InitiateDepositInput): Promise<DepositInstructions> {
  if (input.amountMinor <= 0n) throw Errors.badRequest("Deposit amount must be positive");
  const enabled = await getEnabledGateways();
  if (!enabled.includes(input.gateway)) throw Errors.badRequest("This payment method is not enabled");
  if (PHONE_GATEWAYS.includes(input.gateway)) {
    if (!input.phone) throw Errors.badRequest("Phone number is required for mobile-money payments");
    input.phone = validatePhoneNumber(input.phone);
  }

  const client = getXdigitexClient();
  if (!client.isConfigured()) throw Errors.unprocessable("Payment provider is not configured");

  const internalRef = `DEP-${Date.now()}-${randomId(6)}`;

  // 1. Internal record FIRST — written before any provider call.
  const record = await prisma.paymentRecord.create({
    data: {
      internalRef,
      kind: "DEPOSIT",
      gateway: input.gateway,
      organizationId: input.organizationId,
      initiatedById: input.actorId,
      amountMinor: input.amountMinor,
      currency: env.finance.currency,
      status: "PENDING",
    },
  });

  // 2. Provider call.
  try {
    const result = await client.initiatePayment({
      amountMinor: input.amountMinor,
      currency: env.finance.currency,
      gateway: input.gateway,
      phone: input.phone,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      description: input.description ?? "LipaHub wallet deposit",
      internalRef,
    });

    await prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        providerRef: result.providerRef,
        providerResponse: result.raw as never,
        feeMinor: result.fee !== undefined ? BigInt(Math.round(result.fee * 100)) : 0n,
        netMinor: result.netAmount !== undefined ? BigInt(Math.round(result.netAmount * 100)) : null,
      },
    });

    await audit({
      actorId: input.actorId,
      actorRole: "BUSINESS",
      action: "payments.deposit_initiated",
      entityType: "payment_record",
      entityId: record.id,
      metadata: { internalRef, providerRef: result.providerRef, gateway: input.gateway, amountMinor: input.amountMinor.toString() },
    });

    return {
      internalRef,
      providerRef: result.providerRef,
      kind: result.kind,
      message: result.message,
      redirectUrl: result.redirectUrl,
      checkoutUrl: result.checkoutUrl,
      qrcodeLink: result.qrcodeLink,
    };
  } catch (e) {
    const reason = e instanceof ProviderError ? `${e.kind}: ${e.message}` : String(e);
    await prisma.paymentRecord.update({
      where: { id: record.id },
      data: { status: "FAILED", failureReason: reason.slice(0, 500) },
    });
    await audit({
      actorId: input.actorId,
      actorRole: "BUSINESS",
      action: "payments.deposit_initiation_failed",
      entityType: "payment_record",
      entityId: record.id,
      metadata: { internalRef, reason: reason.slice(0, 200) },
    });
    throw Errors.unprocessable(`Payment initiation failed: ${reason.slice(0, 200)}`);
  }
}

// ── Authoritative settlement ─────────────────────────────────────────

/**
 * Credits the org wallet for a VERIFIED completed deposit.
 * Ledger: Dr provider-clearing NET / Cr org-funds-held NET.
 * (Net because the provider retains its processing fee — this keeps the
 * internal provider-clearing account reconcilable with the provider wallet.)
 */
export async function settleDeposit(recordId: string, verified: ProviderPaymentStatus, source: "webhook" | "reconciliation"): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const record = await tx.paymentRecord.findUnique({ where: { id: recordId } });
    if (!record) throw Errors.notFound("Payment record not found");
    if (record.status === "COMPLETED") return; // idempotent
    if (record.kind !== "DEPOSIT" || !record.organizationId) throw Errors.internal("settleDeposit called for a non-deposit record");

    const grossMinor = BigInt(Math.round(verified.amount * 100));
    const feeMinor = verified.fee !== undefined ? BigInt(Math.round(verified.fee * 100)) : 0n;
    const netMinor = verified.net_amount !== undefined ? BigInt(Math.round(verified.net_amount * 100)) : grossMinor - feeMinor;
    if (netMinor <= 0n) throw Errors.internal("Verified deposit has non-positive net amount");

    const { journalId } = await postJournal(tx, {
      kind: "ORG_DEPOSIT",
      memo: `Wallet deposit ${record.internalRef} via ${record.gateway ?? "provider"} (${source})`,
      referenceType: "organization",
      referenceId: record.organizationId,
      idempotencyKey: `deposit:${record.internalRef}`,
      lines: [
        { account: ACCOUNTS.providerClearing.code, debit: netMinor, referenceType: "organization", referenceId: record.organizationId },
        { account: ACCOUNTS.orgFundsHeld.code, credit: netMinor, referenceType: "organization", referenceId: record.organizationId },
      ],
    });

    await tx.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: "COMPLETED",
        feeMinor,
        netMinor,
        journalId,
        settledAt: new Date(),
        providerResponse: verified as never,
      },
    });
  });

  await audit({
    action: "payments.deposit_settled",
    entityType: "payment_record",
    entityId: recordId,
    metadata: { source, providerRef: verified.reference, net: verified.net_amount ?? verified.amount - (verified.fee ?? 0) },
  });
}

// ── Webhook processing ───────────────────────────────────────────────

export interface WebhookInput {
  eventType: string;
  payload: Record<string, unknown>;
  ip?: string;
  secretOk: boolean;
}

export interface WebhookOutcome {
  deliveryId: string;
  status: "PROCESSED" | "IGNORED" | "REJECTED" | "FAILED";
  outcome: string;
}

export async function processWebhook(input: WebhookInput): Promise<WebhookOutcome> {
  const delivery = await prisma.webhookDelivery.create({
    data: {
      eventType: input.eventType,
      reference: typeof input.payload.reference === "string" ? input.payload.reference : null,
      payload: input.payload as never,
      signaturePresent: input.secretOk,
      ip: input.ip,
      status: "RECEIVED",
    },
  });

  const finish = (status: WebhookOutcome["status"], outcome: string, relatedPaymentId?: string) =>
    prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status, outcome: outcome.slice(0, 500), relatedPaymentId },
    }).then(() => ({ deliveryId: delivery.id, status, outcome }));

  try {
    // Shared-secret gate (our convention; provider publishes no signature scheme).
    if (env.xdigitex.webhookSecret && !input.secretOk) {
      await audit({ action: "payments.webhook_rejected", entityType: "webhook_delivery", entityId: delivery.id, metadata: { reason: "missing or mismatched webhook secret" } });
      return finish("REJECTED", "missing or mismatched webhook secret");
    }

    if (input.eventType !== "payment.completed" && input.eventType !== "payment.failed") {
      return finish("IGNORED", `unhandled event type ${input.eventType}`);
    }

    const reference = typeof input.payload.reference === "string" ? input.payload.reference : null;
    if (!reference) {
      return finish("REJECTED", "webhook payload missing reference");
    }

    const record = await prisma.paymentRecord.findUnique({ where: { providerRef: reference } });
    if (!record) {
      await audit({ action: "payments.webhook_rejected", entityType: "webhook_delivery", entityId: delivery.id, metadata: { reason: "unknown reference", reference } });
      return finish("REJECTED", `unknown reference ${reference}`);
    }

    // Idempotency: already-final records are not re-processed.
    if (record.status === "COMPLETED" || record.status === "FAILED" || record.status === "REVERSED") {
      return finish("IGNORED", `payment already ${record.status}`, record.id);
    }

    // Authoritative verification — the webhook payload alone is never trusted.
    const client = getXdigitexClient();
    let verified: ProviderPaymentStatus;
    try {
      verified = await client.getPaymentStatus(reference);
    } catch (e) {
      const reason = e instanceof ProviderError ? `${e.kind}: ${e.message}` : String(e);
      return finish("FAILED", `status verification failed — record left untouched (${reason.slice(0, 200)})`, record.id);
    }

    // Reference + amount + currency + status must all agree.
    if (verified.reference !== reference) {
      return finish("REJECTED", `status endpoint returned a different reference (${verified.reference})`, record.id);
    }
    const verifiedMinor = BigInt(Math.round(verified.amount * 100));
    if (verifiedMinor !== record.amountMinor) {
      await audit({ action: "payments.webhook_rejected", entityType: "payment_record", entityId: record.id, metadata: { reason: "amount mismatch", expected: record.amountMinor.toString(), got: verifiedMinor.toString() } });
      return finish("REJECTED", `amount mismatch: record ${record.amountMinor} vs provider ${verifiedMinor}`, record.id);
    }
    if (verified.currency.toUpperCase() !== record.currency.toUpperCase()) {
      return finish("REJECTED", `currency mismatch: record ${record.currency} vs provider ${verified.currency}`, record.id);
    }

    if (input.eventType === "payment.completed") {
      if (verified.status !== "completed") {
        return finish("IGNORED", `webhook says completed but provider status is ${verified.status} — awaiting authoritative confirmation`, record.id);
      }
      await settleDeposit(record.id, verified, "webhook");
      return finish("PROCESSED", "deposit credited after authoritative verification", record.id);
    }

    // payment.failed
    if (verified.status !== "failed") {
      return finish("IGNORED", `webhook says failed but provider status is ${verified.status} — awaiting authoritative confirmation`, record.id);
    }
    await prisma.paymentRecord.update({
      where: { id: record.id },
      data: { status: "FAILED", failureReason: `provider reported failure (verified via status endpoint)`, settledAt: new Date() },
    });
    await audit({ action: "payments.deposit_failed", entityType: "payment_record", entityId: record.id, metadata: { providerRef: reference } });
    return finish("PROCESSED", "payment marked FAILED after verification", record.id);
  } catch (e) {
    const outcome = `processing error: ${String((e as Error).message ?? e).slice(0, 300)}`;
    return finish("FAILED", outcome);
  }
}

// ── Withdrawals (two-phase: reserve → provider → settle/reverse) ─────

export interface AdminWithdrawalDecision {
  withdrawalId: string;
  adminId: string;
}

export async function approveAndSubmitWithdrawal(params: AdminWithdrawalDecision): Promise<{ status: string; providerRef?: string; message?: string }> {
  const client = getXdigitexClient();
  if (!client.isConfigured()) {
    // Sandbox path — legacy immediate settlement (used in dev/tests).
    const result = await legacyApproveWithdrawal(params);
    return { status: result.status };
  }

  const policy = await getWithdrawalPolicy();
  const w = await prisma.withdrawalRequest.findUnique({ where: { id: params.withdrawalId } });
  if (!w) throw Errors.notFound("Withdrawal request not found");
  if (w.status !== "PENDING_REVIEW") throw Errors.conflict(`Withdrawal is ${w.status}, not PENDING_REVIEW`);
  if (w.amountMinor < policy.minMinor) throw Errors.unprocessable(`Below minimum withdrawal (${policy.minMinor} minor units)`);
  if (w.amountMinor > policy.maxMinor) throw Errors.unprocessable(`Above maximum withdrawal (${policy.maxMinor} minor units)`);
  validatePhoneNumber(w.destination);

  // 1. Reserve the worker balance (worker-payable → withdrawal-clearing).
  const recordId = await prisma.$transaction(async (tx) => {
    const balance = await workerPayableBalance(tx, w.workerId);
    if (balance < w.amountMinor) throw Errors.unprocessable("Worker balance changed; insufficient funds for this withdrawal");

    const { journalId } = await postJournal(tx, {
      kind: "WITHDRAWAL_RESERVE",
      memo: `Withdrawal reserve ${w.id}`,
      referenceType: "worker",
      referenceId: w.workerId,
      idempotencyKey: `wd-reserve:${w.id}`,
      postedById: params.adminId,
      lines: [
        { account: ACCOUNTS.workerPayable.code, debit: w.amountMinor },
        { account: ACCOUNTS.withdrawalClearing.code, credit: w.amountMinor },
      ],
    });

    const record = await tx.paymentRecord.create({
      data: {
        internalRef: `WDR-INT-${w.id}`,
        kind: "WITHDRAWAL",
        gateway: "mobile",
        workerId: w.workerId,
        initiatedById: params.adminId,
        amountMinor: w.amountMinor,
        currency: w.currency,
        status: "PENDING",
        journalId,
      },
    });
    await tx.withdrawalRequest.update({
      where: { id: w.id },
      data: { status: "PROCESSING", reviewedById: params.adminId, journalId },
    });
    return record.id;
  });

  // 2. Provider submission (outside the ledger transaction).
  try {
    const result = await client.initiateWithdrawal({
      amountMinor: w.amountMinor,
      currency: w.currency,
      accountNumber: w.destination,
    });
    await prisma.paymentRecord.update({
      where: { id: recordId },
      data: {
        providerRef: result.providerRef,
        status: "PENDING",
        providerResponse: result.raw as never,
        feeMinor: result.fee !== undefined ? BigInt(Math.round(result.fee * 100)) : withdrawalFeeMinor(w.amountMinor),
      },
    });
    await prisma.withdrawalRequest.update({
      where: { id: w.id },
      data: { providerRef: result.providerRef, status: "PROCESSING" },
    });
    await audit({
      actorId: params.adminId,
      actorRole: "ADMIN",
      action: "finance.withdrawal_submitted",
      entityType: "withdrawal_request",
      entityId: w.id,
      metadata: { providerRef: result.providerRef },
    });
    return { status: "PROCESSING", providerRef: result.providerRef, message: result.message };
  } catch (e) {
    // Provider refused the payout → release the reservation back.
    const reason = e instanceof ProviderError ? `${e.kind}: ${e.message}` : String(e);
    await prisma.$transaction(async (tx) => {
      await postJournal(tx, {
        kind: "WITHDRAWAL_REVERSAL",
        memo: `Withdrawal submission failed — release reserve ${w.id}`,
        referenceType: "worker",
        referenceId: w.workerId,
        idempotencyKey: `wd-reverse:${w.id}`,
        postedById: params.adminId,
        lines: [
          { account: ACCOUNTS.withdrawalClearing.code, debit: w.amountMinor },
          { account: ACCOUNTS.workerPayable.code, credit: w.amountMinor },
        ],
      });
      await tx.paymentRecord.update({
        where: { id: recordId },
        data: { status: "REVERSED", failureReason: reason.slice(0, 500) },
      });
      await tx.withdrawalRequest.update({
        where: { id: w.id },
        data: { status: "FAILED", reviewNote: reason.slice(0, 400) },
      });
    });
    await audit({
      actorId: params.adminId,
      actorRole: "ADMIN",
      action: "finance.withdrawal_submission_failed",
      entityType: "withdrawal_request",
      entityId: w.id,
      metadata: { reason: reason.slice(0, 200) },
    });
    throw Errors.unprocessable(`Provider rejected the withdrawal: ${reason.slice(0, 200)}`);
  }
}

/** Marks a verified completed withdrawal as paid. */
async function settleWithdrawal(recordId: string, note: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const record = await tx.paymentRecord.findUnique({ where: { id: recordId } });
    if (!record || record.status === "COMPLETED") return;
    if (record.kind !== "WITHDRAWAL" || !record.workerId) throw Errors.internal("settleWithdrawal called for non-withdrawal");
    const w = await tx.withdrawalRequest.findUnique({ where: { id: record.internalRef.replace("WDR-INT-", "") } });
    if (!w) throw Errors.internal("Withdrawal request missing for payment record");

    const { journalId } = await postJournal(tx, {
      kind: "WITHDRAWAL_EXECUTED",
      memo: `Withdrawal paid ${w.id} (${note})`,
      referenceType: "worker",
      referenceId: w.workerId,
      idempotencyKey: `wd-settle:${w.id}`,
      lines: [
        { account: ACCOUNTS.withdrawalClearing.code, debit: w.amountMinor },
        { account: ACCOUNTS.providerClearing.code, credit: w.amountMinor },
      ],
    });
    await tx.paymentRecord.update({
      where: { id: record.id },
      data: { status: "COMPLETED", journalId, settledAt: new Date() },
    });
    await tx.withdrawalRequest.update({
      where: { id: w.id },
      data: { status: "PAID", journalId },
    });
  });
  await audit({ action: "finance.withdrawal_settled", entityType: "payment_record", entityId: recordId, metadata: { note } });
}

/** Returns a reserved withdrawal to the worker when the provider reports failure. */
async function reverseWithdrawal(recordId: string, note: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const record = await tx.paymentRecord.findUnique({ where: { id: recordId } });
    if (!record || record.status === "REVERSED" || record.status === "COMPLETED") return;
    if (record.kind !== "WITHDRAWAL" || !record.workerId) throw Errors.internal("reverseWithdrawal called for non-withdrawal");
    const w = await tx.withdrawalRequest.findUnique({ where: { id: record.internalRef.replace("WDR-INT-", "") } });
    if (!w) throw Errors.internal("Withdrawal request missing for payment record");

    await postJournal(tx, {
      kind: "WITHDRAWAL_REVERSAL",
      memo: `Withdrawal reversal ${w.id} (${note})`,
      referenceType: "worker",
      referenceId: w.workerId,
      idempotencyKey: `wd-reverse-final:${w.id}`,
      lines: [
        { account: ACCOUNTS.withdrawalClearing.code, debit: w.amountMinor },
        { account: ACCOUNTS.workerPayable.code, credit: w.amountMinor },
      ],
    });
    await tx.paymentRecord.update({
      where: { id: record.id },
      data: { status: "REVERSED", failureReason: note.slice(0, 500), settledAt: new Date() },
    });
    await tx.withdrawalRequest.update({
      where: { id: w.id },
      data: { status: "FAILED", reviewNote: note.slice(0, 400) },
    });
  });
  await audit({ action: "finance.withdrawal_reversed", entityType: "payment_record", entityId: recordId, metadata: { note } });
}

// ── Reconciliation worker ────────────────────────────────────────────

export interface ReconcileReport {
  depositsChecked: number;
  depositsSettled: number;
  depositsFailed: number;
  withdrawalsChecked: number;
  withdrawalsSettled: number;
  withdrawalsReversed: number;
  withdrawalsUncertain: number;
  providerErrors: number;
}

export interface ReconcileOptions {
  /** Scope to one organization (targeted admin/test sweeps). */
  organizationId?: string;
  /** Scope to one worker's withdrawals. */
  workerId?: string;
  /** Max records per kind per sweep (default 100). */
  limit?: number;
}

export async function reconcilePendingPayments(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    depositsChecked: 0, depositsSettled: 0, depositsFailed: 0,
    withdrawalsChecked: 0, withdrawalsSettled: 0, withdrawalsReversed: 0,
    withdrawalsUncertain: 0, providerErrors: 0,
  };
  const client = getXdigitexClient();
  if (!client.isConfigured()) return report;
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MINUTES * 60_000);
  const uncertainCutoff = new Date(Date.now() - WITHDRAWAL_UNCERTAIN_AFTER_MINUTES * 60_000);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  // Deposits: authoritative per-reference status endpoint.
  // Oldest first so orphaned records cannot starve newly-aged ones out of
  // the batch; 404s (reference unknown to the provider) are resolved to
  // UNCERTAIN for admin review rather than retried forever.
  const pendingDeposits = await prisma.paymentRecord.findMany({
    where: {
      kind: "DEPOSIT",
      status: { in: ["PENDING", "PROCESSING"] },
      createdAt: { lt: cutoff },
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  for (const record of pendingDeposits) {
    if (!record.providerRef) continue;
    report.depositsChecked++;
    try {
      const status = await client.getPaymentStatus(record.providerRef);
      const verifiedMinor = BigInt(Math.round(status.amount * 100));
      if (verifiedMinor !== record.amountMinor || status.currency.toUpperCase() !== record.currency.toUpperCase()) {
        // Mismatch found by reconciliation → surface for admin, never credit.
        await prisma.paymentRecord.update({ where: { id: record.id }, data: { status: "UNCERTAIN", failureReason: `reconciliation mismatch: amount/currency differ from provider` } });
        continue;
      }
      if (status.status === "completed") {
        await settleDeposit(record.id, status, "reconciliation");
        report.depositsSettled++;
      } else if (status.status === "failed") {
        await prisma.paymentRecord.update({ where: { id: record.id }, data: { status: "FAILED", failureReason: "provider reports failed", settledAt: new Date() } });
        report.depositsFailed++;
      }
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "HTTP" && e.httpStatus === 404) {
        // The provider does not know this reference at all. Never credit;
        // park it for admin review so it cannot clog every future sweep.
        await prisma.paymentRecord.update({
          where: { id: record.id },
          data: { status: "UNCERTAIN", failureReason: "provider has no record of this reference (404) — admin review required" },
        });
        report.providerErrors++;
        continue;
      }
      report.providerErrors++; // provider downtime/timeout — retried next sweep
    }
  }

  // Withdrawals: paginated history (no single-status endpoint documented).
  const pendingWithdrawals = await prisma.paymentRecord.findMany({
    where: {
      kind: "WITHDRAWAL",
      status: { in: ["PENDING", "PROCESSING"] },
      createdAt: { lt: cutoff },
      ...(opts.workerId ? { workerId: opts.workerId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (pendingWithdrawals.length > 0) {
    let historyItems: Array<{ reference: string; status: string; amount?: number; fee?: number; currency?: string }> = [];
    let historyAvailable = true;
    try {
      // Pull up to 3 pages of history for reconciliation.
      for (let page = 1; page <= 3; page++) {
        const res = await client.listWithdrawals(page);
        historyItems = historyItems.concat(res.items);
        if (res.items.length === 0) break;
      }
    } catch {
      historyAvailable = false;
      report.providerErrors++;
    }

    for (const record of pendingWithdrawals) {
      if (!record.providerRef) continue;
      report.withdrawalsChecked++;
      if (!historyAvailable) continue;
      const item = historyItems.find((i) => i.reference === record.providerRef);
      if (!item) {
        if (record.createdAt < uncertainCutoff) {
          await prisma.paymentRecord.update({ where: { id: record.id }, data: { status: "UNCERTAIN", failureReason: "reference not found in provider withdrawal history — admin review required (never auto-retried)" } });
          report.withdrawalsUncertain++;
        }
        continue;
      }
      const s = item.status.toLowerCase();
      if (s === "completed") {
        await settleWithdrawal(record.id, "provider history reports completed");
        report.withdrawalsSettled++;
      } else if (s === "failed" || s === "reversed") {
        await reverseWithdrawal(record.id, "provider history reports failed");
        report.withdrawalsReversed++;
      }
      // pending/processing → leave for the next sweep.
    }
  }

  return report;
}

// ── Org wallet → campaign funding ────────────────────────────────────

export async function fundCampaignFromWalletService(params: {
  organizationId: string;
  campaignId: string;
  amountMinor: bigint;
  actorId: string;
  idempotencyKey: string;
}): Promise<{ fundingId: string; replayed: boolean }> {
  if (params.amountMinor <= 0n) throw Errors.badRequest("Funding amount must be positive");

  const existing = await prisma.fundingRecord.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  if (existing) return { fundingId: existing.id, replayed: true };

  const campaign = await prisma.campaign.findUnique({ where: { id: params.campaignId } });
  if (!campaign) throw Errors.notFound("Campaign not found");
  if (campaign.organizationId !== params.organizationId) throw Errors.forbidden("Campaign belongs to another organization");
  if (["COMPLETED", "CANCELLED"].includes(campaign.status)) throw Errors.conflict("Campaign is closed to funding");

  const fundingId = await prisma.$transaction(async (tx) => {
    const { journalId, replayed } = await fundCampaignFromWallet(tx, {
      organizationId: params.organizationId,
      campaignId: params.campaignId,
      amountMinor: params.amountMinor,
      actorId: params.actorId,
      idempotencyKey: `wallet-fund:${params.idempotencyKey}`,
    });
    void replayed;
    const fr = await tx.fundingRecord.create({
      data: {
        organizationId: params.organizationId,
        campaignId: params.campaignId,
        provider: "MANUAL",
        externalRef: journalId,
        amountMinor: params.amountMinor,
        currency: campaign.currency,
        status: "CONFIRMED",
        idempotencyKey: params.idempotencyKey,
        journalId,
      },
    });
    if (campaign.status === "DRAFT") {
      await tx.campaign.update({ where: { id: campaign.id }, data: { status: "FUNDED" } });
    }
    return fr.id;
  });

  await audit({
    actorId: params.actorId,
    actorRole: "BUSINESS",
    action: "finance.campaign_funded_from_wallet",
    entityType: "funding_record",
    entityId: fundingId,
    metadata: { campaignId: params.campaignId, amountMinor: params.amountMinor.toString() },
  });
  return { fundingId, replayed: false };
}

// ── Provider balance & reconciliation snapshot ───────────────────────

export interface ReconciliationSnapshot {
  provider: { balance: number; lockedBalance?: number; availableBalance?: number; currency: string } | null;
  providerError?: string;
  internal: {
    providerClearingBalanceMinor: bigint;
    completedDepositsMinor: bigint;
    completedWithdrawalsMinor: bigint;
    depositFeesMinor: bigint;
    withdrawalFeesMinor: bigint;
    pendingPayments: number;
    uncertainPayments: number;
  };
  deltaMinor: bigint | null;
}

export async function getReconciliationSnapshot(): Promise<ReconciliationSnapshot> {
  const client = getXdigitexClient();
  let provider: ReconciliationSnapshot["provider"] = null;
  let providerError: string | undefined;
  if (client.isConfigured()) {
    try {
      const b = await client.getBalance();
      provider = { balance: b.balance, lockedBalance: b.locked_balance, availableBalance: b.available_balance, currency: b.currency };
    } catch (e) {
      providerError = e instanceof ProviderError ? `${e.kind}: ${e.message}` : String(e);
    }
  }

  const [clearing, deposits, withdrawals, depositFees, withdrawalFees, pending, uncertain] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      where: { accountCode: ACCOUNTS.providerClearing.code },
      _sum: { amountMinor: true },
    }),
    prisma.paymentRecord.aggregate({ where: { kind: "DEPOSIT", status: "COMPLETED" }, _sum: { amountMinor: true } }),
    prisma.paymentRecord.aggregate({ where: { kind: "WITHDRAWAL", status: "COMPLETED" }, _sum: { amountMinor: true } }),
    prisma.paymentRecord.aggregate({ where: { kind: "DEPOSIT", status: "COMPLETED" }, _sum: { feeMinor: true } }),
    prisma.paymentRecord.aggregate({ where: { kind: "WITHDRAWAL", status: "COMPLETED" }, _sum: { feeMinor: true } }),
    prisma.paymentRecord.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
    prisma.paymentRecord.count({ where: { status: "UNCERTAIN" } }),
  ]);

  const clearingBalance = clearing._sum.amountMinor ?? 0n;
  const deltaMinor = provider ? BigInt(Math.round(provider.balance * 100)) - clearingBalance : null;

  return {
    provider,
    providerError,
    internal: {
      providerClearingBalanceMinor: clearingBalance,
      completedDepositsMinor: deposits._sum.amountMinor ?? 0n,
      completedWithdrawalsMinor: withdrawals._sum.amountMinor ?? 0n,
      depositFeesMinor: depositFees._sum.feeMinor ?? 0n,
      withdrawalFeesMinor: withdrawalFees._sum.feeMinor ?? 0n,
      pendingPayments: pending,
      uncertainPayments: uncertain,
    },
    deltaMinor,
  };
}

// ── Admin: connection test (never reveals the key) ───────────────────

export async function testProviderConnection(): Promise<{ ok: boolean; message: string; balance?: string }> {
  const client = getXdigitexClient();
  if (!client.isConfigured()) return { ok: false, message: "No API key configured (XDIGITEX_PAY_API_KEY is empty)." };
  try {
    const b = await client.getBalance();
    return { ok: true, message: `Connected. Provider wallet: ${b.balance} ${b.currency} (available ${b.available_balance ?? "—"}).`, balance: `${b.balance} ${b.currency}` };
  } catch (e) {
    const msg = e instanceof ProviderError ? `${e.kind}: ${e.message}` : String(e);
    return { ok: false, message: `Connection failed: ${msg.slice(0, 300)}` };
  }
}

export { getEnabledGateways, XDIGITEX_GATEWAYS };
export { getPaymentAdapter };
