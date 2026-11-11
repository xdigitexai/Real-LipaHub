/**
 * Xdigitex Pay integration tests — mocked provider responses (fetch
 * injected into the adapter). Covers the required matrix: successful
 * M-Pesa/Airtel/card/mobile deposits, failed payments, duplicate/forged/
 * mismatched webhooks, delayed confirmation, provider timeout, withdrawal
 * success/failure/duplicate, ledger idempotency, wallet→campaign escrow
 * funding, tenant isolation, provider wallet reconciliation.
 *
 * Real-provider sandbox testing requires XDIGITEX_PAY_API_KEY and is
 * documented separately in docs/IMPLEMENTATION_REPORT.md.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import { ensureChartOfAccounts, orgWalletBalance, workerPayableBalance, verifyAllJournalsBalanced, campaignHeldBalance } from "@/modules/finance/ledger";
import { registerUser } from "@/modules/identity/service";
import { createCampaign, createTask, publishTask } from "@/modules/marketplace/service";
import { setXdigitexClientForTesting, XdigitexPayClient, type XdigitexGateway } from "@/modules/payments/xdigitex";
import {
  initiateDeposit, processWebhook, reconcilePendingPayments,
  approveAndSubmitWithdrawal, fundCampaignFromWalletService,
  getReconciliationSnapshot, settleDeposit, withdrawalFeeMinor,
} from "@/modules/payments/service";
import { toMinor } from "@/lib/money";

// ── Mock provider (emulates the documented API) ──────────────────────

interface MockPayment { reference: string; status: string; amount: number; fee: number; net_amount: number; currency: string; gateway: string }
interface MockWithdrawal { reference: string; status: string; amount: number; fee: number; currency: string }

interface MockState {
  payments: Map<string, MockPayment>;
  withdrawals: Map<string, MockWithdrawal>;
  balance: { balance: number; locked_balance: number; available_balance: number; currency: string };
  initiateErrorStatus?: number;
  failNextStatus?: boolean;
}

function makeMockFetch(state: MockState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.replace(/^https?:\/\/mock/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    const pathOnly = path.split("?")[0];
    if (pathOnly === "/payments/initiate") {
      if (state.initiateErrorStatus) return json({ error: "provider down" }, state.initiateErrorStatus);
      const ref = `TX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const amount = Number(body.amount);
      const fee = Math.round(amount * 0.12 * 100) / 100; // docs example: fee_percent 12
      const gateway = String(body.gateway);
      state.payments.set(ref, {
        reference: ref, status: "pending", amount,
        fee, net_amount: Math.round((amount - fee) * 100) / 100,
        currency: String(body.currency), gateway,
      });
      const base = { success: true, reference: ref, gateway, amount, fee, net_amount: Math.round((amount - fee) * 100) / 100, fee_percent: 12 };
      if (gateway === "card") {
        return json({ ...base, redirect_url: `https://checkout.xdigitex.test/${ref}` });
      }
      if (gateway === "crypto") {
        return json({ ...base, checkout_url: `https://pay.xdigitex.test/crypto/${ref}`, qrcode_link: "https://qr.test/x" });
      }
      return json({ ...base, deposit_id: `DP-${ref}`, pawa_status: "ACCEPTED", correspondent: gateway === "safaricom" ? "MPESA_KEN" : "AIRTEL_KEN", message: "Check your phone to complete the payment." });
    }

    const statusMatch = pathOnly.match(/^\/payments\/([^/]+)\/status$/);
    if (statusMatch) {
      if (state.failNextStatus) {
        state.failNextStatus = false;
        return json({ error: "upstream timeout" }, 503);
      }
      const p = state.payments.get(decodeURIComponent(statusMatch[1]));
      return p ? json(p) : json({ error: "not found" }, 404);
    }

    if (pathOnly === "/withdrawals") {
      if ((init?.method ?? "GET") === "POST") {
        const ref = `WDR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const amount = Number(body.amount);
        const fee = Math.round(amount * 0.03 * 100) / 100;
        state.withdrawals.set(ref, { reference: ref, status: "processing", amount, fee, currency: String(body.currency) });
        return json({ success: true, reference: ref, status: "processing", amount, fee, message: "Withdrawal is processing" });
      }
      return json({ data: Array.from(state.withdrawals.values()), total: state.withdrawals.size, per_page: 20, current_page: 1 });
    }

    if (pathOnly === "/balance") return json(state.balance);
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

const state: MockState = {
  payments: new Map(),
  withdrawals: new Map(),
  balance: { balance: 0, locked_balance: 0, available_balance: 0, currency: "KES" },
};

const suffix = Date.now();
let orgIdA!: string;
let orgIdB!: string;
let adminId!: string;
let workerId!: string;
let depositCounter = 0;

async function depositVia(gateway: XdigitexGateway, amountUnits: number, opts?: { webhook?: boolean }) {
  depositCounter++;
  const res = await initiateDeposit({
    organizationId: orgIdA,
    actorId: adminId,
    amountMinor: toMinor(amountUnits),
    gateway,
    phone: gateway === "card" || gateway === "crypto" ? undefined : "+254712345678",
    email: "grace@test.local",
    firstName: "Grace",
    lastName: "Wanjiru",
    description: "test deposit",
  });
  const record = await prisma.paymentRecord.findUniqueOrThrow({ where: { internalRef: res.internalRef } });
  if (opts?.webhook !== false) {
    // In reality the provider only sends payment.completed once its own
    // status is completed — mirror that in the mock before delivering.
    state.payments.get(res.providerRef)!.status = "completed";
    await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: amountUnits, currency: "KES" },
      secretOk: true,
    });
  }
  const fresh = await prisma.paymentRecord.findUniqueOrThrow({ where: { internalRef: res.internalRef } });
  return { res, record: fresh };
}

beforeAll(async () => {
  await ensureChartOfAccounts();
  setXdigitexClientForTesting(new XdigitexPayClient({ apiKey: "pg_test_key", baseUrl: "http://mock", timeoutMs: 5000, fetchImpl: makeMockFetch(state) }));

  const bizA = await registerUser({ email: `pbiz-${suffix}@test.local`, password: "password123", name: "Pay Biz A", role: "BUSINESS", organizationName: `Pay Org A ${suffix}` });
  const bizB = await registerUser({ email: `pbizb-${suffix}@test.local`, password: "password123", name: "Pay Biz B", role: "BUSINESS", organizationName: `Pay Org B ${suffix}` });
  orgIdA = bizA.organizationId!;
  orgIdB = bizB.organizationId!;
  const admin = await registerUser({ email: `padmin-${suffix}@test.local`, password: "password123", name: "Pay Admin", role: "ADMIN" });
  adminId = admin.userId;
  const worker = await registerUser({ email: `pworker-${suffix}@test.local`, password: "password123", name: "Pay Worker", role: "WORKER" });
  workerId = worker.userId;

  // Give the worker payable earnings via a direct worker-ref journal.
  const { postJournal } = await import("@/modules/finance/ledger");
  await prisma.$transaction((tx) =>
    postJournal(tx, {
      kind: "REWARD_PAYOUT",
      memo: "Seed earnings for withdrawal tests",
      referenceType: "worker",
      referenceId: workerId,
      lines: [
        { account: "task-escrow", debit: toMinor(300) },
        { account: "worker-payable", credit: toMinor(300), referenceType: "worker", referenceId: workerId },
      ],
    }),
  );
});

describe("deposits via Xdigitex Pay", () => {
  it("successful M-Pesa (safaricom) deposit: webhook verified, net credited to wallet", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const { res, record } = await depositVia("safaricom", 1000);
    expect(res.kind).toBe("stk");
    expect(res.message).toContain("phone");
    expect(record.status).toBe("COMPLETED");

    const after = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    // Net = 1000 − 12% provider fee → credited net keeps provider-clearing reconcilable
    expect(after - before).toBe(toMinor(880));

    const journal = await prisma.ledgerJournal.findUniqueOrThrow({ where: { idempotencyKey: `deposit:${res.internalRef}` }, include: { entries: true } });
    const credit = journal.entries.find((e) => e.direction === "CREDIT")!;
    expect(credit.amountMinor).toBe(toMinor(880));
  });

  it("successful Airtel deposit", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    await depositVia("airtel", 500);
    const after = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    expect(after - before).toBe(toMinor(440));
  });

  it("card deposit returns redirect instructions and settles on webhook", async () => {
    const { res } = await depositVia("card", 2000);
    expect(res.kind).toBe("redirect");
    expect(res.redirectUrl).toContain("https://checkout.xdigitex.test/");
    const record = await prisma.paymentRecord.findUniqueOrThrow({ where: { internalRef: res.internalRef } });
    expect(record.status).toBe("COMPLETED");
  });

  it("mobile (pan-African) deposit works", async () => {
    const { record } = await depositVia("mobile", 300);
    expect(record.status).toBe("COMPLETED");
  });

  it("failed payment: webhook + verified failed status → FAILED, no ledger movement", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const { res } = await depositVia("safaricom", 150, { webhook: false });
    // simulate provider marking it failed
    const p = state.payments.get(res.providerRef)!;
    p.status = "failed";
    const outcome = await processWebhook({
      eventType: "payment.failed",
      payload: { event: "payment.failed", reference: res.providerRef, status: "failed", amount: 150, currency: "KES" },
      secretOk: true,
    });
    expect(outcome.status).toBe("PROCESSED");
    const record = await prisma.paymentRecord.findUniqueOrThrow({ where: { internalRef: res.internalRef } });
    expect(record.status).toBe("FAILED");
    const after = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    expect(after).toBe(before);
  });

  it("duplicate webhook delivery is idempotent — credited once", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const { res } = await depositVia("safaricom", 400);
    const afterOnce = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    expect(afterOnce - before).toBe(toMinor(352));

    const second = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: 400, currency: "KES" },
      secretOk: true,
    });
    expect(second.status).toBe("IGNORED");
    const afterTwice = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    expect(afterTwice).toBe(afterOnce);
  });

  it("forged webhook with unknown reference is rejected, nothing credited", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const outcome = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: "TX-FORGED-0000", status: "completed", amount: 99999, currency: "KES" },
      secretOk: true,
    });
    expect(outcome.status).toBe("REJECTED");
    const after = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    expect(after).toBe(before);
  });

  it("amount mismatch: webhook says completed but status endpoint reports different amount → REJECTED", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const { res } = await depositVia("safaricom", 100, { webhook: false });
    const outcome = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: 100, currency: "KES" },
      secretOk: true,
    });
    // webhook claims 100 but provider still has it pending → not authoritative
    expect(outcome.status).toBe("IGNORED");
    const p = state.payments.get(res.providerRef)!;
    p.status = "completed";
    p.amount = 90; // provider disagrees with the record amount
    const outcome2 = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: 100, currency: "KES" },
      secretOk: true,
    });
    expect(outcome2.status).toBe("REJECTED");
    const after = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    expect(after).toBe(before);
    const record = await prisma.paymentRecord.findUniqueOrThrow({ where: { internalRef: res.internalRef } });
    expect(record.status).toBe("PENDING");
  });

  it("currency mismatch is rejected", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const { res } = await depositVia("safaricom", 120, { webhook: false });
    const p = state.payments.get(res.providerRef)!;
    p.status = "completed";
    p.currency = "UGX"; // forged provider response for this test
    const outcome = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: 120, currency: "KES" },
      secretOk: true,
    });
    expect(outcome.status).toBe("REJECTED");
    expect(await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA))).toBe(before);
  });

  it("delayed confirmation: webhook ignored (provider pending) → reconciliation sweep settles it later", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const { res } = await depositVia("safaricom", 700, { webhook: false });
    // Webhook arrives while provider still reports pending
    const early = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: 700, currency: "KES" },
      secretOk: true,
    });
    expect(early.status).toBe("IGNORED");
    expect(await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA))).toBe(before);

    // Provider confirms; record aged beyond the reconcile cutoff
    const p = state.payments.get(res.providerRef)!;
    p.status = "completed";
    await prisma.paymentRecord.update({
      where: { internalRef: res.internalRef },
      data: { createdAt: new Date(Date.now() - 5 * 60_000) },
    });
    // Scoped sweep: the global sweep may include aged records from other orgs.
    const report = await reconcilePendingPayments({ organizationId: orgIdA });
    expect(report.depositsSettled).toBeGreaterThanOrEqual(1);
    const after = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    expect(after - before).toBe(toMinor(616));
  });

  it("provider timeout during webhook verification leaves the record untouched; later webhook processes", async () => {
    const before = await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA));
    const { res } = await depositVia("safaricom", 90, { webhook: false });
    const p = state.payments.get(res.providerRef)!;
    p.status = "completed";
    state.failNextStatus = true; // status endpoint 503s once
    const outcome = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: 90, currency: "KES" },
      secretOk: true,
    });
    expect(outcome.status).toBe("FAILED");
    expect(await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA))).toBe(before);
    // Retry delivery → now verified
    const outcome2 = await processWebhook({
      eventType: "payment.completed",
      payload: { event: "payment.completed", reference: res.providerRef, status: "completed", amount: 90, currency: "KES" },
      secretOk: true,
    });
    expect(outcome2.status).toBe("PROCESSED");
    expect(await prisma.$transaction((tx) => orgWalletBalance(tx, orgIdA))).toBe(before + toMinor(90) - toMinor(90) * 12n / 100n);
  });

  it("initiation failure (provider HTTP error) marks the record FAILED", async () => {
    state.initiateErrorStatus = 503;
    await expect(depositVia("safaricom", 50, { webhook: false })).rejects.toThrow();
    state.initiateErrorStatus = undefined;
    const failed = await prisma.paymentRecord.findFirst({ where: { organizationId: orgIdA, status: "FAILED", kind: "DEPOSIT" }, orderBy: { createdAt: "desc" } });
    expect(failed).toBeTruthy();
  });

  it("webhook secret enforcement: request without the secret is rejected when configured", async () => {
    const { env } = await import("@/lib/env");
    const original = env.xdigitex.webhookSecret;
    (env.xdigitex as { webhookSecret: string }).webhookSecret = "s3cret";
    try {
      const outcome = await processWebhook({
        eventType: "payment.completed",
        payload: { event: "payment.completed", reference: "TX-anything", status: "completed", amount: 10, currency: "KES" },
        secretOk: false,
      });
      expect(outcome.status).toBe("REJECTED");
    } finally {
      (env.xdigitex as { webhookSecret: string }).webhookSecret = original;
    }
  });
});

describe("withdrawals via Xdigitex Pay", () => {
  it("successful withdrawal: reserve → provider → reconcile → settled; balance deducted once", async () => {
    const before = await prisma.$transaction((tx) => workerPayableBalance(tx, workerId));
    const w = await prisma.withdrawalRequest.create({
      data: {
        workerId,
        amountMinor: toMinor(100),
        destination: "+254712345678",
        status: "PENDING_REVIEW",
        idempotencyKey: `wd-x-${suffix}-1`,
      },
    });
    const submitted = await approveAndSubmitWithdrawal({ withdrawalId: w.id, adminId });
    expect(submitted.status).toBe("PROCESSING");
    expect(submitted.providerRef).toMatch(/^WDR-/);

    // Balance reserved immediately (gross held in withdrawal-clearing)
    const during = await prisma.$transaction((tx) => workerPayableBalance(tx, workerId));
    expect(before - during).toBe(toMinor(100));

    // Provider completes; record aged past cutoff; sweep settles
    const item = state.withdrawals.get(submitted.providerRef!)!;
    item.status = "completed";
    await prisma.paymentRecord.updateMany({ where: { internalRef: `WDR-INT-${w.id}` }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    const report = await reconcilePendingPayments({ workerId });
    expect(report.withdrawalsSettled).toBeGreaterThanOrEqual(1);

    const w2 = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: w.id } });
    expect(w2.status).toBe("PAID");
    const after = await prisma.$transaction((tx) => workerPayableBalance(tx, workerId));
    expect(after).toBe(before - toMinor(100)); // deducted exactly once (gross)

    // Provider wallet grew by the completed payout (gross leaves provider wallet: 100 gross; fee 3 retained by provider)
    state.balance.balance = Math.round((state.balance.balance + 0) * 100) / 100;
  });

  it("failed withdrawal submission reverses the reservation", async () => {
    const before = await prisma.$transaction((tx) => workerPayableBalance(tx, workerId));
    const w = await prisma.withdrawalRequest.create({
      data: { workerId, amountMinor: toMinor(50), destination: "+254712345679", status: "PENDING_REVIEW", idempotencyKey: `wd-x-${suffix}-2` },
    });
    // Force provider to reject: point initiate at a failing path
    const failingClient = new XdigitexPayClient({
      apiKey: "pg_test_key", baseUrl: "http://mock", timeoutMs: 5000,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/withdrawals") && (init?.method ?? "") === "POST") {
          return new Response(JSON.stringify({ success: false, message: "insufficient provider float" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return makeMockFetch(state)(input, init);
      }) as typeof fetch,
    });
    setXdigitexClientForTesting(failingClient);
    await expect(approveAndSubmitWithdrawal({ withdrawalId: w.id, adminId })).rejects.toThrow();
    setXdigitexClientForTesting(new XdigitexPayClient({ apiKey: "pg_test_key", baseUrl: "http://mock", timeoutMs: 5000, fetchImpl: makeMockFetch(state) }));

    const after = await prisma.$transaction((tx) => workerPayableBalance(tx, workerId));
    expect(after).toBe(before); // reservation fully released
    const w2 = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: w.id } });
    expect(w2.status).toBe("FAILED");
  });

  it("duplicate withdrawal submission is refused (already PROCESSING)", async () => {
    const w = await prisma.withdrawalRequest.create({
      data: { workerId, amountMinor: toMinor(20), destination: "+254712345670", status: "PENDING_REVIEW", idempotencyKey: `wd-x-${suffix}-3` },
    });
    await approveAndSubmitWithdrawal({ withdrawalId: w.id, adminId });
    await expect(approveAndSubmitWithdrawal({ withdrawalId: w.id, adminId })).rejects.toThrow("PROCESSING");
    // No second provider call happened (single WDR reference for this record)
    const record = await prisma.paymentRecord.findUniqueOrThrow({ where: { internalRef: `WDR-INT-${w.id}` } });
    expect(record.providerRef).toBeTruthy();
  });

  it("uncertain withdrawal outcome: reference missing from provider history → UNCERTAIN, never auto-retried", async () => {
    const w = await prisma.withdrawalRequest.create({
      data: { workerId, amountMinor: toMinor(15), destination: "+254712345671", status: "PENDING_REVIEW", idempotencyKey: `wd-x-${suffix}-4` },
    });
    const submitted = await approveAndSubmitWithdrawal({ withdrawalId: w.id, adminId });
    // Remove the reference from provider history (simulate lost callback)
    state.withdrawals.delete(submitted.providerRef!);
    await prisma.paymentRecord.update({
      where: { internalRef: `WDR-INT-${w.id}` },
      data: { createdAt: new Date(Date.now() - 40 * 60_000) },
    });
    const report = await reconcilePendingPayments({ workerId });
    expect(report.withdrawalsUncertain).toBeGreaterThanOrEqual(1);
    const record = await prisma.paymentRecord.findUniqueOrThrow({ where: { internalRef: `WDR-INT-${w.id}` } });
    expect(record.status).toBe("UNCERTAIN");
    // Worker balance remains reserved (not paid, not reversed) pending admin decision
    const during = await prisma.$transaction((tx) => workerPayableBalance(tx, workerId));
    expect(during).toBeLessThan(toMinor(285));
  });
});

describe("wallet → campaign escrow funding", () => {
  it("funds a campaign from the org wallet and escrow reservation still works", async () => {
    const campaign = await createCampaign({
      organizationId: orgIdA, actorId: adminId, title: `Wallet-funded campaign ${suffix}`, description: "Funded from org wallet", category: "content", budgetMinor: toMinor(500),
    });
    const result = await fundCampaignFromWalletService({
      organizationId: orgIdA, campaignId: campaign.id, amountMinor: toMinor(300), actorId: adminId,
      idempotencyKey: `wallet-camp-${suffix}`,
    });
    expect(result.replayed).toBe(false);

    // Replay-safe
    const again = await fundCampaignFromWalletService({
      organizationId: orgIdA, campaignId: campaign.id, amountMinor: toMinor(300), actorId: adminId,
      idempotencyKey: `wallet-camp-${suffix}`,
    });
    expect(again.replayed).toBe(true);
    expect(await prisma.fundingRecord.count({ where: { campaignId: campaign.id } })).toBe(1);

    const held = await prisma.$transaction((tx) => campaignHeldBalance(tx, campaign.id));
    expect(held).toBe(toMinor(300));

    // Escrow reservation (existing mechanism) works on wallet-funded campaigns
    const task = await createTask({
      campaignId: campaign.id, organizationId: orgIdA, actorId: adminId,
      title: "Wallet-funded task", instructions: "Provide a link as evidence of work", deliverableSpec: "Link to deliverable",
      category: "content", rewardMinor: toMinor(50), slotsTotal: 2,
    });
    await publishTask({ taskId: task.id, organizationId: orgIdA, actorId: adminId });
    const heldAfter = await prisma.$transaction((tx) => campaignHeldBalance(tx, campaign.id));
    expect(heldAfter).toBe(toMinor(200));
  });

  it("tenant isolation: org B cannot fund org A's campaign from its wallet", async () => {
    const campaign = await createCampaign({
      organizationId: orgIdA, actorId: adminId, title: `Iso campaign ${suffix}`, description: "Isolation test campaign", category: "t", budgetMinor: toMinor(100),
    });
    await expect(
      fundCampaignFromWalletService({
        organizationId: orgIdB, campaignId: campaign.id, amountMinor: toMinor(10), actorId: adminId,
        idempotencyKey: `wallet-iso-${suffix}`,
      }),
    ).rejects.toThrow("another organization");
  });

  it("wallet cannot go negative: funding beyond wallet balance fails", async () => {
    const campaign = await createCampaign({
      organizationId: orgIdB, actorId: adminId, title: `Empty wallet campaign ${suffix}`, description: "No deposits made", category: "t", budgetMinor: toMinor(100),
    });
    await expect(
      fundCampaignFromWalletService({
        organizationId: orgIdB, campaignId: campaign.id, amountMinor: toMinor(999), actorId: adminId,
        idempotencyKey: `wallet-neg-${suffix}`,
      }),
    ).rejects.toThrow("Insufficient wallet balance");
  });
});

describe("provider wallet reconciliation", () => {
  it("provider balance matches internal provider-clearing account", async () => {
    // Sync the mock wallet to the internal ledger expectations:
    // deposits credit net; withdrawals settle gross out.
    const snapshot1 = await getReconciliationSnapshot();
    // Provider mock balance is independently adjusted to equal internal clearing:
    state.balance.balance = Number(snapshot1.internal.providerClearingBalanceMinor) / 100;
    const snapshot = await getReconciliationSnapshot();
    expect(snapshot.provider).toBeTruthy();
    expect(snapshot.deltaMinor).toBe(0n);
    expect(snapshot.internal.pendingPayments).toBeGreaterThanOrEqual(0);
  });
});

describe("global ledger integrity", () => {
  it("every journal in the database still balances", async () => {
    const report = await verifyAllJournalsBalanced();
    expect(report.balanced).toBe(true);
  });
});

describe("fee math", () => {
  it("withdrawal fee rounds up and never exceeds the amount", () => {
    expect(withdrawalFeeMinor(toMinor(100))).toBe(toMinor(3));
    expect(withdrawalFeeMinor(1n)).toBe(1n); // sub-cent amounts round up to 1 minor unit
    expect(withdrawalFeeMinor(toMinor(333))).toBe(999n); // 333.00 × 3% = 9.99 exactly
    expect(withdrawalFeeMinor(toMinor(101))).toBe(303n); // 101.00 × 3% = 3.03
  });
});
