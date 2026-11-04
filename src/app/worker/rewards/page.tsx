import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { workerPayableBalance } from "@/modules/finance";
import { formatMoney } from "@/lib/money";
import { WithdrawalForm } from "@/components/worker-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rewards & withdrawals — LipaHub AI" };

export default async function RewardsPage() {
  const ctx = await getAuthContext();
  const workerId = ctx!.userId;

  const [payable, journals, withdrawals] = await Promise.all([
    prisma.$transaction((tx) => workerPayableBalance(tx, workerId)),
    prisma.ledgerEntry.findMany({
      where: { journal: { referenceType: "worker", referenceId: workerId } },
      include: { journal: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.withdrawalRequest.findMany({
      where: { workerId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const pendingReview = withdrawals.filter((w) => w.status === "PENDING_REVIEW").reduce((acc, w) => acc + w.amountMinor, 0n);
  const available = payable - pendingReview > 0n ? payable - pendingReview : 0n;

  return (
    <Shell nav={[
      { href: "/worker", label: "Overview" },
      { href: "/worker/discover", label: "Discover work" },
      { href: "/worker/assignments", label: "My assignments" },
      { href: "/worker/rewards", label: "Rewards & withdrawals" },
    ]}>
      <h1>Rewards &amp; withdrawals</h1>
      <div className="lh-grid lh-grid-3">
        <div className="lh-card">
          <div className="lh-stat-label">Ledger balance</div>
          <div className="lh-stat lh-mono">{formatMoney(payable)}</div>
          <div className="lh-muted">Double-entry ledger — not an editable balance</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">In withdrawal review</div>
          <div className="lh-stat lh-mono">{formatMoney(pendingReview)}</div>
          <div className="lh-muted">Requests awaiting admin approval</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Withdrawable now</div>
          <div className="lh-stat lh-mono">{formatMoney(available)}</div>
        </div>
      </div>

      <h2>Request a withdrawal</h2>
      <div className="lh-card">
        {available > 0n ? (
          <WithdrawalForm maxAmount={Number(available)} />
        ) : (
          <p className="lh-muted">Nothing withdrawable yet — earnings appear here after a business approves your work.</p>
        )}
      </div>

      <h2>Withdrawal history</h2>
      {withdrawals.length === 0 ? (
        <div className="lh-card lh-muted">No withdrawal requests yet.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Requested</th><th>Amount</th><th>Destination</th><th>Status</th><th>Review note</th></tr></thead>
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w.id}>
                <td>{new Date(w.createdAt).toLocaleString("en-KE")}</td>
                <td className="lh-mono">{formatMoney(w.amountMinor)}</td>
                <td className="lh-mono">{w.destination}</td>
                <td><StatusBadge status={w.status} /></td>
                <td className="lh-muted">{w.reviewNote ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Reward ledger</h2>
      {journals.length === 0 ? (
        <div className="lh-card lh-muted">No ledger movements yet.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Date</th><th>Journal</th><th>Movement</th><th>Memo</th></tr></thead>
          <tbody>
            {journals.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.createdAt).toLocaleString("en-KE")}</td>
                <td>{e.journal.kind.replace(/_/g, " ")}</td>
                <td className="lh-mono">{e.direction === "CREDIT" ? "+" : "−"}{formatMoney(e.amountMinor)}</td>
                <td className="lh-muted">{e.journal.memo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
