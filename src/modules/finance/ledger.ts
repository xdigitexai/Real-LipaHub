/**
 * Finance module — double-entry ledger.
 *
 * Invariants (enforced here, verified by tests):
 *  - Journals are posted inside the caller's transaction (same tx as the
 *    domain state change).
 *  - Every journal has ≥ 2 entries; debits == credits (BigInt).
 *  - Amounts are positive integer minor units.
 *  - Entries are append-only; corrections are reversing journals.
 *  - Idempotency: posting with the same idempotencyKey is a no-op that
 *    returns the original journal (retry safety).
 *
 * The AI layer has no access to any function in this module.
 */
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import type { JournalKind, Prisma } from "@prisma/client";

export const ACCOUNTS = {
  providerClearing: { code: "provider-clearing", name: "Provider clearing (cash in/out)", kind: "ASSET" as const },
  campaignFundsHeld: { code: "campaign-funds-held", name: "Campaign funds held (unreserved)", kind: "LIABILITY" as const },
  taskEscrow: { code: "task-escrow", name: "Task escrow (reserved rewards)", kind: "LIABILITY" as const },
  workerPayable: { code: "worker-payable", name: "Worker payable (earnings)", kind: "LIABILITY" as const },
  platformRevenue: { code: "platform-revenue", name: "Platform revenue (commission)", kind: "REVENUE" as const },
  withdrawalClearing: { code: "withdrawal-clearing", name: "Withdrawal clearing (in flight)", kind: "LIABILITY" as const },
} as const;

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS]["code"];

export interface JournalLine {
  account: AccountCode;
  debit?: bigint;
  credit?: bigint;
}

export interface PostJournalInput {
  kind: JournalKind;
  memo: string;
  lines: JournalLine[];
  idempotencyKey?: string;
  referenceType?: string;
  referenceId?: string;
  postedById?: string;
}

/** Ensures the canonical chart of accounts exists (idempotent). */
export async function ensureChartOfAccounts(): Promise<void> {
  for (const account of Object.values(ACCOUNTS)) {
    await prisma.ledgerAccount.upsert({
      where: { code: account.code },
      update: {},
      create: { code: account.code, name: account.name, kind: account.kind },
    });
  }
}

function validateLines(lines: JournalLine[]): void {
  if (lines.length < 2) throw Errors.internal("Journal must have at least two lines");
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    const d = line.debit ?? 0n;
    const c = line.credit ?? 0n;
    if (d < 0n || c < 0n) throw Errors.badRequest("Ledger amounts must be positive");
    if ((d > 0n && c > 0n) || (d === 0n && c === 0n)) {
      throw Errors.badRequest("Each line must be exactly a debit or a credit");
    }
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw Errors.internal(`Unbalanced journal: debits=${debits} credits=${credits}`);
  }
  if (debits <= 0n) throw Errors.badRequest("Journal total must be positive");
}

/**
 * Post a balanced journal within the given transaction.
 * Idempotent by idempotencyKey when provided.
 */
export async function postJournal(
  tx: Prisma.TransactionClient,
  input: PostJournalInput,
): Promise<{ journalId: string; replayed: boolean }> {
  validateLines(input.lines);

  if (input.idempotencyKey) {
    const existing = await tx.ledgerJournal.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { journalId: existing.id, replayed: true };
  }

  const accountCodes = [...new Set(input.lines.map((l) => l.account))];
  const accounts = await tx.ledgerAccount.findMany({
    where: { code: { in: accountCodes } },
    select: { id: true, code: true },
  });
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  for (const code of accountCodes) {
    if (!byCode.has(code)) throw Errors.internal(`Unknown ledger account: ${code}`);
  }

  const journal = await tx.ledgerJournal.create({
    data: {
      kind: input.kind,
      memo: input.memo,
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      postedById: input.postedById,
      entries: {
        create: input.lines.map((l) => ({
          accountId: byCode.get(l.account)!,
          direction: (l.debit ?? 0n) > 0n ? "DEBIT" : "CREDIT",
          amountMinor: (l.debit ?? 0n) > 0n ? l.debit! : l.credit!,
          accountCode: l.account,
        })),
      },
    },
    select: { id: true },
  });

  return { journalId: journal.id, replayed: false };
}

/** Signed balance of an account: credits − debits for liabilities/revenue, debits − credits for assets/expenses. */
export async function accountBalance(tx: Prisma.TransactionClient, code: AccountCode): Promise<bigint> {
  const account = await tx.ledgerAccount.findUnique({ where: { code } });
  if (!account) throw Errors.internal(`Unknown ledger account: ${code}`);
  const agg = await tx.ledgerEntry.groupBy({
    by: ["direction"],
    where: { accountId: account.id },
    _sum: { amountMinor: true },
  });
  let debits = 0n;
  let credits = 0n;
  for (const row of agg) {
    const amt = row._sum.amountMinor ?? 0n;
    if (row.direction === "DEBIT") debits += amt;
    else credits += amt;
  }
  return account.kind === "ASSET" || account.kind === "EXPENSE" ? debits - credits : credits - debits;
}

/**
 * Funds currently held (funded but not reserved) for a campaign.
 * Derived from domain tables written in the same transaction as their
 * journals: Σ confirmed funding − Σ active reservations.
 */
export async function campaignHeldBalance(tx: Prisma.TransactionClient, campaignId: string): Promise<bigint> {
  const funding = await tx.fundingRecord.aggregate({
    where: { campaignId, status: "CONFIRMED" },
    _sum: { amountMinor: true },
  });
  const reserved = await tx.taskReservation.aggregate({
    where: { campaignId, status: { in: ["HELD", "RELEASED_TO_WORKER"] } },
    _sum: { amountMinor: true },
  });
  return (funding._sum.amountMinor ?? 0n) - (reserved._sum.amountMinor ?? 0n);
}

/** Worker's withdrawable earnings (ledger-derived — never a stored column). */
export async function workerPayableBalance(tx: Prisma.TransactionClient, workerId: string): Promise<bigint> {
  const agg = await tx.ledgerEntry.groupBy({
    by: ["direction"],
    where: { accountCode: ACCOUNTS.workerPayable.code, journal: { referenceType: "worker", referenceId: workerId } },
    _sum: { amountMinor: true },
  });
  let debits = 0n;
  let credits = 0n;
  for (const row of agg) {
    const amt = row._sum.amountMinor ?? 0n;
    if (row.direction === "DEBIT") debits += amt;
    else credits += amt;
  }
  return credits - debits;
}

/** Global ledger sanity check: every journal balances. Expensive — for tests/reconciliation. */
export async function verifyAllJournalsBalanced(): Promise<{ journals: number; balanced: boolean; offenders: string[] }> {
  const journals = await prisma.ledgerJournal.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  const offenders: string[] = [];
  for (const j of journals) {
    const entries = await prisma.ledgerEntry.findMany({ where: { journalId: j.id } });
    let debits = 0n;
    let credits = 0n;
    for (const e of entries) {
      if (e.direction === "DEBIT") debits += e.amountMinor;
      else credits += e.amountMinor;
    }
    if (debits !== credits) offenders.push(j.id);
  }
  return { journals: journals.length, balanced: offenders.length === 0, offenders };
}
