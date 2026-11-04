import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { adminWithdrawalDecisionAction } from "@/app/actions/admin";
import { adminApproveWithdrawalViaProviderAction } from "@/app/actions/payments";
import { isXdigitexConfigured, getWithdrawalPolicy } from "@/modules/payments";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdrawal approvals — LipaHub AI" };

export default async function AdminWithdrawalsPage() {
  await getAuthContext();
  const providerConfigured = isXdigitexConfigured();
  const policy = await getWithdrawalPolicy();
  const [pending, history] = await Promise.all([
    prisma.withdrawalRequest.findMany({
      where: { status: "PENDING_REVIEW" },
      include: { worker: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.withdrawalRequest.findMany({
      where: { status: { not: "PENDING_REVIEW" } },
      include: { worker: { select: { name: true, email: true } } },
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
  ]);

  return (
    <Shell nav={[
      { href: "/admin", label: "Overview" },
      { href: "/admin/payments", label: "Payments" },
      { href: "/admin/payments/reconciliation", label: "Reconciliation" },
      { href: "/admin/payments/settings", label: "Payment settings" },
      { href: "/admin/opportunities/sources", label: "Opportunity sources" },
      { href: "/admin/opportunities/moderation", label: "Moderation queue" },
      { href: "/admin/opportunities/catalogue", label: "Catalogue" },
      { href: "/admin/users", label: "Users & organizations" },
      { href: "/admin/withdrawals", label: "Withdrawals" },
      { href: "/admin/ledger", label: "Ledger" },
      { href: "/admin/agents", label: "AI agents" },
      { href: "/admin/audit", label: "Audit log" },
    ]}>
      <h1>Withdrawal approvals</h1>
      <p className="lh-muted">
        Sensitive financial operation — every approval reserves the worker&apos;s ledger balance and submits
        the payout to the payment provider. Balance is re-checked at approval time.
        {providerConfigured
          ? " Provider is configured: approval submits POST /withdrawals; final status is reconciled against the provider history."
          : " Sandbox mode: approval settles instantly against the simulated adapter."}
        {" "}Policy: min {formatMoney(policy.minMinor)} · max {formatMoney(policy.maxMinor)}.
      </p>

      <h2>Pending review ({pending.length})</h2>
      {pending.length === 0 ? (
        <div className="lh-card lh-muted">No pending withdrawals.</div>
      ) : (
        pending.map((w) => {
          const fee = (w.amountMinor * 3n) / 100n;
          const net = w.amountMinor - fee;
          return (
            <div key={w.id} className="lh-card">
              <div className="lh-row">
                <strong>{w.worker.name}</strong>
                <span className="lh-muted">{w.worker.email}</span>
                <span className="lh-spacer" />
                <strong className="lh-mono">{formatMoney(w.amountMinor)}</strong>
              </div>
              <p className="lh-muted">
                Destination: {w.destination} · requested {new Date(w.createdAt).toLocaleString("en-KE")} ·
                provider fee ~{formatMoney(fee)} → net payout <strong>{formatMoney(net)}</strong>
              </p>
              <form action={providerConfigured ? adminApproveWithdrawalViaProviderAction : adminWithdrawalDecisionAction} className="lh-row">
                <input type="hidden" name="withdrawalId" value={w.id} />
                <button className="lh-btn lh-btn-sm" type="submit" name="decision" value="approve">
                  {providerConfigured ? "Approve & submit to provider" : "Approve & pay (sandbox)"}
                </button>
                <input className="lh-input" name="note" placeholder="Rejection note" style={{ maxWidth: 220 }} />
                <button className="lh-btn lh-btn-sm lh-btn-danger" type="submit" name="decision" value="reject">Reject</button>
              </form>
            </div>
          );
        })
      )}

      <h2>History</h2>
      {history.length === 0 ? (
        <div className="lh-card lh-muted">No decisions yet.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Worker</th><th>Amount</th><th>Status</th><th>Updated</th><th>Note</th></tr></thead>
          <tbody>
            {history.map((w) => (
              <tr key={w.id}>
                <td>{w.worker.name}</td>
                <td className="lh-mono">{formatMoney(w.amountMinor)}</td>
                <td><StatusBadge status={w.status} /></td>
                <td className="lh-muted">{new Date(w.updatedAt).toLocaleString("en-KE")}</td>
                <td className="lh-muted">{w.reviewNote ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
