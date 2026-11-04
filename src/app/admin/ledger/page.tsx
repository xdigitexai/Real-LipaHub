import { Shell } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { verifyAllJournalsBalanced } from "@/modules/finance";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ledger — LipaHub AI" };

export default async function AdminLedgerPage() {
  await getAuthContext();
  const [accounts, journals, integrity] = await Promise.all([
    prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } }),
    prisma.ledgerJournal.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
      include: { entries: true, postedBy: { select: { name: true } } },
    }),
    verifyAllJournalsBalanced(),
  ]);

  const balances = new Map<string, bigint>();
  for (const j of journals) {
    for (const e of j.entries) {
      const prev = balances.get(e.accountCode) ?? 0n;
      balances.set(e.accountCode, prev + (e.direction === "DEBIT" ? e.amountMinor : -e.amountMinor));
    }
  }

  return (
    <Shell nav={[
      { href: "/admin", label: "Overview" },
      { href: "/admin/opportunities/sources", label: "Opportunity sources" },
      { href: "/admin/opportunities/moderation", label: "Moderation queue" },
      { href: "/admin/opportunities/catalogue", label: "Catalogue" },
      { href: "/admin/users", label: "Users & organizations" },
      { href: "/admin/withdrawals", label: "Withdrawals" },
      { href: "/admin/ledger", label: "Ledger" },
      { href: "/admin/agents", label: "AI agents" },
      { href: "/admin/audit", label: "Audit log" },
    ]}>
      <h1>Financial ledger</h1>
      <div className={`lh-alert ${integrity.balanced ? "lh-alert-info" : "lh-alert-error"}`}>
        <strong>Integrity check:</strong> {integrity.journals} journal(s) scanned — {integrity.balanced ? "all balanced ✓ (debits = credits)" : `IMBALANCE detected in ${integrity.offenders.length} journal(s)`}
      </div>

      <h2>Chart of accounts (full-history balances)</h2>
      <table className="lh-table">
        <thead><tr><th>Account</th><th>Kind</th><th>Recent movement (last 60 journals)</th></tr></thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td><code>{a.code}</code> — {a.name}</td>
              <td>{a.kind}</td>
              <td className="lh-mono">{formatMoney(balances.get(a.code) ?? 0n)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent journals</h2>
      <table className="lh-table">
        <thead><tr><th>When</th><th>Kind</th><th>Memo</th><th>Reference</th><th>Posted by</th><th>Lines</th></tr></thead>
        <tbody>
          {journals.map((j) => (
            <tr key={j.id}>
              <td className="lh-muted">{new Date(j.createdAt).toLocaleString("en-KE")}</td>
              <td>{j.kind.replace(/_/g, " ")}</td>
              <td>{j.memo}</td>
              <td className="lh-muted">{j.referenceType}:{(j.referenceId ?? "").slice(0, 10)}</td>
              <td className="lh-muted">{j.postedBy?.name ?? "system"}</td>
              <td>
                {j.entries.map((e) => (
                  <div key={e.id} className="lh-mono lh-muted" style={{ fontSize: "0.8rem" }}>
                    {e.direction === "DEBIT" ? "Dr" : "Cr"} {e.accountCode} {formatMoney(e.amountMinor)}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Shell>
  );
}
