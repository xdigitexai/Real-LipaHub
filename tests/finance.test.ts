/**
 * Finance engine tests — the heart of financial integrity.
 * Requires the dockerized PostgreSQL (docker compose up postgres).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import {
  ensureChartOfAccounts,
  postJournal,
  accountBalance,
  verifyAllJournalsBalanced,
} from "@/modules/finance/ledger";
import {
  fundCampaign,
  reserveTaskFunds,
  releaseReservationBack,
  payRewardOnApproval,
  requestWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
} from "@/modules/finance/service";
import { createCampaign, createTask, applyToTask, decideApplication, submitWork, reviewSubmission, publishTask, listOpenTasks } from "@/modules/marketplace/service";
import { registerUser } from "@/modules/identity/service";
import { toMinor, commissionMinor } from "@/lib/money";
import { env } from "@/lib/env";

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedScenario() {
  const suffix = Date.now();
  const admin = await registerUser({ email: `admin-${suffix}@test.local`, password: "password123", name: "Test Admin", role: "ADMIN" });
  const biz = await registerUser({ email: `biz-${suffix}@test.local`, password: "password123", name: "Biz Owner", role: "BUSINESS", organizationName: `Biz ${suffix}` });
  await prisma.organization.update({ where: { id: biz.organizationId! }, data: { verificationStatus: "VERIFIED" } });
  const worker = await registerUser({ email: `worker-${suffix}@test.local`, password: "password123", name: "Worker", role: "WORKER" });
  return { admin, biz, worker };
}

beforeAll(async () => {
  await ensureChartOfAccounts();
});

describe("ledger primitives", () => {
  it("posts a balanced journal and computes balances", async () => {
    const { admin } = await seedScenario();
    const amount = toMinor(100);
    const key = unique("lj");
    await prisma.$transaction(async (tx) => {
      const { journalId, replayed } = await postJournal(tx, {
        kind: "CAMPAIGN_FUNDING",
        memo: "test funding",
        referenceType: "campaign",
        referenceId: "test-campaign",
        idempotencyKey: key,
        postedById: admin.userId,
        lines: [
          { account: "provider-clearing", debit: amount },
          { account: "campaign-funds-held", credit: amount },
        ],
      });
      expect(journalId).toBeTruthy();
      expect(replayed).toBe(false);

      // Idempotent replay returns the same journal
      const second = await postJournal(tx, {
        kind: "CAMPAIGN_FUNDING",
        memo: "test funding",
        idempotencyKey: key,
        lines: [
          { account: "provider-clearing", debit: amount },
          { account: "campaign-funds-held", credit: amount },
        ],
      });
      expect(second.replayed).toBe(true);
      expect(second.journalId).toBe(journalId);
    });
  });

  it("rejects unbalanced journals", async () => {
    await expect(
      prisma.$transaction((tx) =>
        postJournal(tx, {
          kind: "ADJUSTMENT",
          memo: "bad",
          lines: [
            { account: "provider-clearing", debit: toMinor(50) },
            { account: "campaign-funds-held", credit: toMinor(40) },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects single-line and zero journals", async () => {
    await expect(
      prisma.$transaction((tx) =>
        postJournal(tx, {
          kind: "ADJUSTMENT",
          memo: "single",
          lines: [{ account: "provider-clearing", debit: toMinor(50) }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("all persisted journals balance (invariant sweep)", async () => {
    const report = await verifyAllJournalsBalanced();
    expect(report.balanced).toBe(true);
  });
});

describe("campaign funding", () => {
  it("funds a campaign, journals cash in, and is idempotent", async () => {
    const { biz } = await seedScenario();
    const campaign = await createCampaign({
      organizationId: biz.organizationId!,
      actorId: biz.userId,
      title: "Funding test campaign",
      description: "A campaign to test funding",
      category: "testing",
      budgetMinor: toMinor(1000),
    });

    const key = unique("fund");
    const r1 = await fundCampaign({
      organizationId: biz.organizationId!,
      campaignId: campaign.id,
      amountMinor: toMinor(500),
      idempotencyKey: key,
      payer: "254700000000",
    });
    expect(r1.replayed).toBe(false);

    // Retry with same key → no double charge
    const r2 = await fundCampaign({
      organizationId: biz.organizationId!,
      campaignId: campaign.id,
      amountMinor: toMinor(500),
      idempotencyKey: key,
      payer: "254700000000",
    });
    expect(r2.replayed).toBe(true);
    const records = await prisma.fundingRecord.count({ where: { campaignId: campaign.id } });
    expect(records).toBe(1);

    // Held balance reflects exactly one funding
    await prisma.$transaction(async (tx) => {
      const held = await import("@/modules/finance/ledger").then((m) => m.campaignHeldBalance(tx, campaign.id));
      expect(held).toBe(toMinor(500));
    });

    // Campaign transitions to FUNDED
    const refreshed = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    expect(refreshed!.status).toBe("FUNDED");
  });

  it("cannot fund another organization's campaign", async () => {
    const { biz } = await seedScenario();
    const other = await registerUser({ email: `other-${Date.now()}@test.local`, password: "password123", name: "Other", role: "BUSINESS", organizationName: "Other org" });
    const campaign = await createCampaign({
      organizationId: biz.organizationId!,
      actorId: biz.userId,
      title: "Tenant isolation campaign",
      description: "Cross-org funding must fail",
      category: "security",
      budgetMinor: toMinor(100),
    });
    await expect(
      fundCampaign({
        organizationId: other.organizationId!,
        campaignId: campaign.id,
        amountMinor: toMinor(10),
        idempotencyKey: unique("fund-cross"),
        payer: "254700000001",
      }),
    ).rejects.toThrow();
  });
});

describe("task reservation → approval → payout", () => {
  it("publishes payable task only with sufficient funds; rejects over-reservation", async () => {
    const { biz, worker } = await seedScenario();
    const campaign = await createCampaign({
      organizationId: biz.organizationId!,
      actorId: biz.userId,
      title: "Reservation flow campaign",
      description: "Reservation flow description",
      category: "data-entry",
      budgetMinor: toMinor(100),
    });

    const task = await createTask({
      campaignId: campaign.id,
      organizationId: biz.organizationId!,
      actorId: biz.userId,
      title: "Reservation test task",
      instructions: "Follow the instructions precisely",
      deliverableSpec: "A text deliverable",
      category: "data-entry",
      rewardMinor: toMinor(50),
      slotsTotal: 2,
    });

    // Publishing before funding must fail
    await expect(publishTask({ taskId: task.id, organizationId: biz.organizationId!, actorId: biz.userId })).rejects.toThrow();

    await fundCampaign({
      organizationId: biz.organizationId!,
      campaignId: campaign.id,
      amountMinor: toMinor(90),
      idempotencyKey: unique("fund"),
      payer: "254700000002",
    });

    // Need 50*2=100 but only 90 held → must fail
    await expect(publishTask({ taskId: task.id, organizationId: biz.organizationId!, actorId: biz.userId })).rejects.toThrow();

    await fundCampaign({
      organizationId: biz.organizationId!,
      campaignId: campaign.id,
      amountMinor: toMinor(50),
      idempotencyKey: unique("fund"),
      payer: "254700000002",
    });

    const pub = await publishTask({ taskId: task.id, organizationId: biz.organizationId!, actorId: biz.userId });
    expect(pub.published).toBe(true);

    await prisma.$transaction(async (tx) => {
      const held = await import("@/modules/finance/ledger").then((m) => m.campaignHeldBalance(tx, campaign.id));
      expect(held).toBe(toMinor(40)); // 140 funded − 100 reserved
    });
  });

  it("full slice: apply → accept → submit → approve → ledger payout with commission", async () => {
    const { biz, worker } = await seedScenario();
    const campaign = await createCampaign({
      organizationId: biz.organizationId!,
      actorId: biz.userId,
      title: "Full slice campaign",
      description: "End-to-end marketplace slice",
      category: "microtask",
      budgetMinor: toMinor(200),
    });
    await fundCampaign({
      organizationId: biz.organizationId!,
      campaignId: campaign.id,
      amountMinor: toMinor(200),
      idempotencyKey: unique("fund"),
      payer: "254700000003",
    });

    const task = await createTask({
      campaignId: campaign.id,
      organizationId: biz.organizationId!,
      actorId: biz.userId,
      title: "Write a product summary",
      instructions: "Summarize the product in 3 bullet points and provide a link to your document",
      deliverableSpec: "Link to document",
      category: "content",
      rewardMinor: toMinor(40),
      slotsTotal: 1,
    });
    await publishTask({ taskId: task.id, organizationId: biz.organizationId!, actorId: biz.userId });

    const app = await applyToTask({ taskId: task.id, workerId: worker.userId, message: "I can do this" });
    const decision = await decideApplication({ applicationId: app.id, organizationId: biz.organizationId!, actorId: biz.userId, accept: true });
    expect(decision.accepted).toBe(true);

    const submission = await submitWork({
      assignmentId: decision.assignmentId!,
      workerId: worker.userId,
      notes: "Completed summary",
      evidence: [{ kind: "link", label: "Document", value: "https://docs.example.com/summary-1" }],
    });
    expect(submission.submissionId).toBeTruthy();

    // Double submission blocked
    await expect(
      submitWork({
        assignmentId: decision.assignmentId!,
        workerId: worker.userId,
        evidence: [{ kind: "link", value: "https://docs.example.com/summary-2" }],
      }),
    ).rejects.toThrow();

    const payout = await reviewSubmission({
      submissionId: submission.submissionId,
      organizationId: biz.organizationId!,
      actorId: biz.userId,
      approve: true,
    });
    expect(payout.approved).toBe(true);

    const commission = commissionMinor(toMinor(40), env.finance.commissionBps);
    expect(payout.commissionMinor).toBe(commission);
    expect(payout.workerMinor).toBe(toMinor(40) - commission);

    // Worker ledger balance reflects the payout
    await prisma.$transaction(async (tx) => {
      const bal = await import("@/modules/finance/ledger").then((m) => m.workerPayableBalance(tx, worker.userId));
      expect(bal).toBe(toMinor(40) - commission);
    });

    // Approving again is impossible
    await expect(
      reviewSubmission({ submissionId: submission.submissionId, organizationId: biz.organizationId!, actorId: biz.userId, approve: true }),
    ).rejects.toThrow();
  });

  it("task with remaining slots stays discoverable after first acceptance (multi-slot)", async () => {
    const { biz } = await seedScenario();
    const w1 = await registerUser({ email: `multi1-${Date.now()}@test.local`, password: "password123", name: "Multi W1", role: "WORKER" });
    const w2 = await registerUser({ email: `multi2-${Date.now()}@test.local`, password: "password123", name: "Multi W2", role: "WORKER" });
    const campaign = await createCampaign({
      organizationId: biz.organizationId!, actorId: biz.userId, title: "Multi-slot campaign", description: "Multi slot discovery campaign", category: "microtask", budgetMinor: toMinor(100),
    });
    await fundCampaign({ organizationId: biz.organizationId!, campaignId: campaign.id, amountMinor: toMinor(100), idempotencyKey: unique("fund"), payer: "254700000010" });
    const task = await createTask({
      campaignId: campaign.id, organizationId: biz.organizationId!, actorId: biz.userId,
      title: `Multi-slot discovery task ${Date.now()}`, instructions: "Provide a link as evidence of work", deliverableSpec: "Link to deliverable",
      category: "microtask", rewardMinor: toMinor(10), slotsTotal: 2,
    });
    await publishTask({ taskId: task.id, organizationId: biz.organizationId!, actorId: biz.userId });

    // w1 accepted → task IN_PROGRESS, still discoverable for w2
    const app1 = await applyToTask({ taskId: task.id, workerId: w1.userId });
    await decideApplication({ applicationId: app1.id, organizationId: biz.organizationId!, actorId: biz.userId, accept: true });
    const open = await listOpenTasks({ search: "Multi-slot discovery task" });
    expect(open.some((t) => t.id === task.id)).toBe(true);

    // w2 can still apply
    const app2 = await applyToTask({ taskId: task.id, workerId: w2.userId });
    expect(app2.status).toBe("PENDING");
  });

  it("duplicate evidence across workers is flagged (FAIL verdict, routed to review)", async () => {
    const { biz } = await seedScenario();
    const w1 = await registerUser({ email: `dupw1-${Date.now()}@test.local`, password: "password123", name: "Dup W1", role: "WORKER" });
    const w2 = await registerUser({ email: `dupw2-${Date.now()}@test.local`, password: "password123", name: "Dup W2", role: "WORKER" });

    const campaign = await createCampaign({
      organizationId: biz.organizationId!, actorId: biz.userId, title: "Dup campaign", description: "Duplicate detection campaign", category: "microtask", budgetMinor: toMinor(200),
    });
    await fundCampaign({ organizationId: biz.organizationId!, campaignId: campaign.id, amountMinor: toMinor(200), idempotencyKey: unique("fund"), payer: "254700000004" });
    const task = await createTask({
      campaignId: campaign.id, organizationId: biz.organizationId!, actorId: biz.userId,
      title: "Dup detection task", instructions: "Provide a link as evidence of work", deliverableSpec: "Link to the deliverable",
      category: "microtask", rewardMinor: toMinor(20), slotsTotal: 2,
    });
    await publishTask({ taskId: task.id, organizationId: biz.organizationId!, actorId: biz.userId });

    const a1 = await applyToTask({ taskId: task.id, workerId: w1.userId });
    const d1 = await decideApplication({ applicationId: a1.id, organizationId: biz.organizationId!, actorId: biz.userId, accept: true });
    const s1 = await submitWork({ assignmentId: d1.assignmentId!, workerId: w1.userId, evidence: [{ kind: "link", value: "https://dup.example.com/same" }] });

    const a2 = await applyToTask({ taskId: task.id, workerId: w2.userId });
    const d2 = await decideApplication({ applicationId: a2.id, organizationId: biz.organizationId!, actorId: biz.userId, accept: true });
    const s2 = await submitWork({ assignmentId: d2.assignmentId!, workerId: w2.userId, evidence: [{ kind: "link", value: "https://dup.example.com/same" }] });

    expect(s2.verdict.verdict).toBe("FAIL");
    const run = await prisma.verificationRun.findFirst({ where: { submissionId: s2.submissionId }, orderBy: { createdAt: "desc" } });
    expect(run!.verdict).toBe("FAIL");
  });
});

describe("withdrawals", () => {
  it("rejects withdrawal exceeding ledger balance", async () => {
    const { worker } = await seedScenario();
    await expect(
      requestWithdrawal({ workerId: worker.userId, amountMinor: toMinor(999), destination: "254700000005", idempotencyKey: unique("wd") }),
    ).rejects.toThrow();
  });

  it("admin approval pays out and journals; rejection leaves money alone", async () => {
    const { biz, worker, admin } = await seedScenario();
    const campaign = await createCampaign({
      organizationId: biz.organizationId!, actorId: biz.userId, title: "Withdrawal campaign", description: "Withdrawal flow campaign", category: "microtask", budgetMinor: toMinor(100),
    });
    await fundCampaign({ organizationId: biz.organizationId!, campaignId: campaign.id, amountMinor: toMinor(100), idempotencyKey: unique("fund"), payer: "254700000006" });
    const task = await createTask({
      campaignId: campaign.id, organizationId: biz.organizationId!, actorId: biz.userId,
      title: "Withdrawal task", instructions: "Provide a link as evidence of work", deliverableSpec: "Link to the deliverable",
      category: "microtask", rewardMinor: toMinor(100), slotsTotal: 1,
    });
    await publishTask({ taskId: task.id, organizationId: biz.organizationId!, actorId: biz.userId });
    const app = await applyToTask({ taskId: task.id, workerId: worker.userId });
    const dec = await decideApplication({ applicationId: app.id, organizationId: biz.organizationId!, actorId: biz.userId, accept: true });
    const sub = await submitWork({ assignmentId: dec.assignmentId!, workerId: worker.userId, evidence: [{ kind: "link", value: "https://wd.example.com/x" }] });
    await reviewSubmission({ submissionId: sub.submissionId, organizationId: biz.organizationId!, actorId: biz.userId, approve: true });

    const commission = commissionMinor(toMinor(100), env.finance.commissionBps);
    const payable = toMinor(100) - commission;

    const key = unique("wd");
    const req = await requestWithdrawal({ workerId: worker.userId, amountMinor: payable, destination: "254700000007", idempotencyKey: key });
    // Replay safety
    const req2 = await requestWithdrawal({ workerId: worker.userId, amountMinor: payable, destination: "254700000007", idempotencyKey: key });
    expect(req2.replayed).toBe(true);

    const rejected = await requestWithdrawal({ workerId: worker.userId, amountMinor: 1n, destination: "254700000007", idempotencyKey: unique("wd") });
    await rejectWithdrawal({ withdrawalId: rejected.withdrawalId, adminId: admin.userId, note: "Below minimum" });

    await approveWithdrawal({ withdrawalId: req.withdrawalId, adminId: admin.userId });
    await prisma.$transaction(async (tx) => {
      const bal = await import("@/modules/finance/ledger").then((m) => m.workerPayableBalance(tx, worker.userId));
      expect(bal).toBe(0n);
    });
  });
});
