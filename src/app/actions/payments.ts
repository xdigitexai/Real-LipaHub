"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/session-server";
import { requireRole } from "@/modules/identity";
import { Errors } from "@/lib/errors";
import { toMinor, fromMinor } from "@/lib/money";
import { randomId } from "@/lib/crypto";
import type { ActionState } from "@/app/actions/auth";
import {
  initiateDeposit, fundCampaignFromWalletService, testProviderConnection,
  reconcilePendingPayments, setSettings, getXdigitexClient, XDIGITEX_GATEWAYS,
  approveAndSubmitWithdrawal, validatePhoneNumber, withdrawalFeeMinor,
} from "@/modules/payments";
import { requestWithdrawal } from "@/modules/finance/service";
import { env } from "@/lib/env";

// ── Business: wallet deposit via Xdigitex Pay ────────────────────────

export async function initiateDepositAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    requireRole(ctx, "BUSINESS");
    const c = ctx!;
    const amountUnits = Number(formData.get("amount"));
    if (!Number.isFinite(amountUnits) || amountUnits <= 0) throw Errors.badRequest("Enter a valid amount");
    const gateway = String(formData.get("gateway") ?? "") as (typeof XDIGITEX_GATEWAYS)[number];
    if (!XDIGITEX_GATEWAYS.includes(gateway)) throw Errors.badRequest("Choose a payment method");

    const instructions = await initiateDeposit({
      organizationId: c.organizationId!,
      actorId: c.userId,
      amountMinor: toMinor(amountUnits),
      gateway,
      phone: String(formData.get("phone") ?? "") || undefined,
      email: String(formData.get("email") ?? "") || c.email,
      firstName: c.name.split(" ")[0] || undefined,
      lastName: c.name.split(" ").slice(1).join(" ") || undefined,
      description: `LipaHub wallet deposit for ${c.organizationId}`,
    });

    revalidatePath("/business");
    if (instructions.kind === "redirect" && instructions.redirectUrl) {
      return { success: `REDIRECT:${instructions.redirectUrl}` };
    }
    if (instructions.kind === "crypto" && instructions.checkoutUrl) {
      return { success: `REDIRECT:${instructions.checkoutUrl}` };
    }
    return {
      success: `STK_SENT:${instructions.internalRef}:${instructions.message ?? "Check your phone to complete the payment."}`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Deposit failed" };
  }
}

// ── Business: fund campaign from wallet ──────────────────────────────

export async function fundFromWalletAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    requireRole(ctx, "BUSINESS");
    const c = ctx!;
    const campaignId = String(formData.get("campaignId"));
    const amountUnits = Number(formData.get("amount"));
    if (!Number.isFinite(amountUnits) || amountUnits <= 0) throw Errors.badRequest("Enter a valid amount");
    const idem = `wallet-${campaignId}-${Date.now()}-${randomId(4)}`;
    await fundCampaignFromWalletService({
      organizationId: c.organizationId!,
      campaignId,
      amountMinor: toMinor(amountUnits),
      actorId: c.userId,
      idempotencyKey: idem,
    });
    revalidatePath(`/business/campaigns/${campaignId}`);
    revalidatePath("/business");
    return { success: `Campaign funded ${(amountUnits).toFixed(2)} ${env.finance.currency} from wallet.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Funding failed" };
  }
}

// ── Worker: withdrawal with fee disclosure ───────────────────────────

export async function requestWithdrawalWithFeeAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await getAuthContext();
    requireRole(ctx, "WORKER");
    const c = ctx!;
    const amountUnits = Number(formData.get("amount"));
    if (!Number.isFinite(amountUnits) || amountUnits <= 0) throw Errors.badRequest("Enter a valid amount");
    const amountMinor = toMinor(amountUnits);
    const destination = validatePhoneNumber(String(formData.get("destination") ?? ""));
    const fee = withdrawalFeeMinor(amountMinor);
    const net = amountMinor - fee;
    if (net <= 0n) throw Errors.badRequest("Amount too small after the 3% provider fee");

    const idem = `wd-ui-${c.userId}-${Date.now()}-${randomId(4)}`;
    await requestWithdrawal({ workerId: c.userId, amountMinor, destination, idempotencyKey: idem });
    revalidatePath("/worker/rewards");
    return {
      success: `Withdrawal request submitted: ${(Number(amountMinor) / 100).toFixed(2)} ${env.finance.currency} requested, provider fee ${(Number(fee) / 100).toFixed(2)}, net payout ${(Number(net) / 100).toFixed(2)}. An administrator will review and submit it to the payment provider.`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Withdrawal request failed" };
  }
}

// ── Admin: approve & submit withdrawal through provider ──────────────

export async function adminApproveWithdrawalViaProviderAction(formData: FormData): Promise<void> {
  "use server";
  const ctx = await getAuthContext();
  requireRole(ctx, "ADMIN");
  await approveAndSubmitWithdrawal({ withdrawalId: String(formData.get("withdrawalId")), adminId: ctx!.userId });
  revalidatePath("/admin/withdrawals");
  revalidatePath("/admin/payments");
}

// ── Admin: settings & connection test & reconciliation ───────────────

export async function testProviderConnectionAction(_prev: ActionState | null, _formData: FormData): Promise<ActionState> {
  try {
    requireRole(await getAuthContext(), "ADMIN");
    const result = await testProviderConnection();
    return result.ok ? { success: result.message } : { error: result.message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Test failed" };
  }
}

export async function savePaymentSettingsAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  try {
    requireRole(await getAuthContext(), "ADMIN");
    const entries: Record<string, string> = {};
    const min = Number(formData.get("minWithdrawal"));
    const max = Number(formData.get("maxWithdrawal"));
    if (Number.isFinite(min) && min > 0) entries["withdrawal.min_minor"] = String(Math.round(min * 100));
    if (Number.isFinite(max) && max > 0) entries["withdrawal.max_minor"] = String(Math.round(max * 100));
    const gateways = XDIGITEX_GATEWAYS.filter((g) => formData.get(`gateway_${g}`) === "on");
    if (gateways.length > 0) entries["payments.enabled_gateways"] = gateways.join(",");
    const recommended = String(formData.get("recommendedGateway") ?? "");
    if (XDIGITEX_GATEWAYS.includes(recommended as never)) entries["payments.recommended_gateway"] = recommended;
    await setSettings(entries);
    revalidatePath("/admin/payments/settings");
    return { success: "Settings saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function retryReconciliationAction(_prev: ActionState | null, _formData: FormData): Promise<ActionState> {
  try {
    requireRole(await getAuthContext(), "ADMIN");
    // SAFE reconciliation: only authoritative provider status checks move
    // money. Nothing is ever forced to "completed".
    const report = await reconcilePendingPayments();
    revalidatePath("/admin/payments");
    revalidatePath("/admin/payments/reconciliation");
    return {
      success: `Reconciliation sweep done — deposits checked ${report.depositsChecked} (settled ${report.depositsSettled}, failed ${report.depositsFailed}); withdrawals checked ${report.withdrawalsChecked} (settled ${report.withdrawalsSettled}, reversed ${report.withdrawalsReversed}, uncertain ${report.withdrawalsUncertain}); provider errors ${report.providerErrors}.`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Reconciliation failed" };
  }
}

// Client polling helper — returns current internal record state.
export async function pollPaymentStatus(internalRef: string): Promise<{ status: string; failureReason?: string | null } | null> {
  const ctx = await getAuthContext();
  if (!ctx) return null;
  const { prisma } = await import("@/lib/db");
  const record = await prisma.paymentRecord.findUnique({ where: { internalRef } });
  if (!record) return null;
  const allowed =
    ctx.role === "ADMIN" ||
    (record.kind === "DEPOSIT" && record.organizationId === ctx.organizationId) ||
    (record.kind === "WITHDRAWAL" && record.workerId === ctx.userId);
  if (!allowed) return null;
  void fromMinor;
  void getXdigitexClient;
  return { status: record.status, failureReason: record.failureReason };
}
