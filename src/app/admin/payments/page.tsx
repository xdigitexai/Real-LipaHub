import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { getReconciliationSnapshot, isXdigitexConfigured } from "@/modules/payments";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payments — LipaHub AI" };

export default async function AdminPaymentsPage() {
  await getAuthContext();
  const configured = isXdigitexConfigured();
  const snapshot = await getReconciliationSnapshot();

  const [deposits, withdrawals, webhooks] = await Promise.all([
    prisma.paymentRecord.findMany({ where: { kind: "DEPOSIT" }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.paymentRecord.findMany({ where: { kind: "WITHDRAWAL" }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.webhookDelivery.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  const totals = {
    depositsCompleted: deposits.filter((d) => d.status === "COMPLETED").length,
    depositsFailed: deposits.filter((d) => d.status === "FAILED").length,
    depositsPending: deposits.filter((d) => ["PENDING", "PROCESSING"].includes(d.status)).length,
  };

  return (
    <Shell nav={[
      { href: "/admin", label: "Overview" },
      { href: "/admin/payments", label: "Payments" },
      { href: "/admin/payments/reconciliation", label: "Reconciliation" },
      { href: "/admin/payments/settings", label: "Payment settings" },
      { href: "/admin/withdrawals", label: "Withdrawal approvals" },
      { href: "/admin/ledger", label: "Ledger" },
      { href: "/admin/audit", label: "Audit log" },
      { href: "/admin/opportunities/sources", label: "Opportunity sources" },
      { href: "/admin/users", label: "Users & organizations" },
    ]}>
      <h1>Payment management</h1>
      <div className={`lh-alert ${configured ? "lh-alert-info" : "lh-alert-warn"}`}>
        {configured
          ? <>Provider <strong>Xdigitex Pay</strong> is configured (API key held server-side, never rendered). Webhook secret {snapshot.providerError ? "" : ""}{""}is {""}enforced per environment configuration.</>
          : <><strong>Sandbox mode</strong> — no provider key configured. Deposits/withdrawals run through the local simulated adapter; nothing touches real money.</>}
      </div>

      <div className="lh-grid lh-grid-3">
        <div className="lh-card">
          <div className="lh-stat-label">Provider wallet</div>
          <div className="lh-stat lh-mono">{snapshot.provider ? `${snapshot.provider.balance.toFixed(2)} ${snapshot.provider.currency}` : "—"}</div>
          <div className="lh-muted">
            {snapshot.providerError ? `Provider error: ${snapshot.providerError.slice(0, 120)}` : snapshot.provider ? `Locked: ${snapshot.provider.lockedBalance ?? "—"}` : "Not configured"}
          </div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Internal provider-clearing</div>
          <div className="lh-stat lh-mono">{formatMoney(snapshot.internal.providerClearingBalanceMinor)}</div>
          <div className="lh-muted">
            {snapshot.deltaMinor !== null ? (snapshot.deltaMinor === 0n ? "Matches provider wallet ✓" : `Δ vs provider: ${formatMoney(snapshot.deltaMinor)} — investigate`) : "Delta unavailable without provider"}
          </div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Completed deposits</div>
          <div className="lh-stat lh-mono">{formatMoney(snapshot.internal.completedDepositsMinor)}</div>
          <div className="lh-muted">{totals.depositsCompleted} payment(s) · fees {formatMoney(snapshot.internal.depositFeesMinor)}</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Completed withdrawals</div>
          <div className="lh-stat lh-mono">{formatMoney(snapshot.internal.completedWithdrawalsMinor)}</div>
          <div className="lh-muted">provider fees {formatMoney(snapshot.internal.withdrawalFeesMinor)}</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Pending payments</div>
          <div className="lh-stat">{snapshot.internal.pendingPayments}</div>
          <div className="lh-muted">Deposits {totals.depositsPending} · failed deposits {totals.depositsFailed}</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Uncertain (admin review)</div>
          <div className="lh-stat">{snapshot.internal.uncertainPayments}</div>
          <div className="lh-muted">Never auto-retried — decide manually</div>
        </div>
      </div>

      <h2>Recent deposit transactions</h2>
      <table className="lh-table">
        <thead><tr><th>When</th><th>Internal ref</th><th>Provider ref</th><th>Gateway</th><th>Gross</th><th>Fee</th><th>Status</th></tr></thead>
        <tbody>
          {deposits.map((d) => (
            <tr key={d.id}>
              <td className="lh-muted">{new Date(d.createdAt).toLocaleString("en-KE")}</td>
              <td><code>{d.internalRef.slice(0, 22)}</code></td>
              <td><code>{d.providerRef ?? "—"}</code></td>
              <td>{d.gateway ?? "—"}</td>
              <td className="lh-mono">{formatMoney(d.amountMinor)}</td>
              <td className="lh-mono">{formatMoney(d.feeMinor)}</td>
              <td><StatusBadge status={d.status} /></td>
            </tr>
          ))}
          {deposits.length === 0 && <tr><td colSpan={7} className="lh-muted">No deposit transactions yet.</td></tr>}
        </tbody>
      </table>

      <h2>Recent withdrawal transactions</h2>
      <table className="lh-table">
        <thead><tr><th>When</th><th>Provider ref</th><th>Gross</th><th>Provider fee</th><th>Status</th></tr></thead>
        <tbody>
          {withdrawals.map((w) => (
            <tr key={w.id}>
              <td className="lh-muted">{new Date(w.createdAt).toLocaleString("en-KE")}</td>
              <td><code>{w.providerRef ?? "—"}</code></td>
              <td className="lh-mono">{formatMoney(w.amountMinor)}</td>
              <td className="lh-mono">{formatMoney(w.feeMinor)}</td>
              <td><StatusBadge status={w.status} /></td>
            </tr>
          ))}
          {withdrawals.length === 0 && <tr><td colSpan={5} className="lh-muted">No withdrawal transactions yet.</td></tr>}
        </tbody>
      </table>

      <h2>Recent webhook deliveries</h2>
      <table className="lh-table">
        <thead><tr><th>When</th><th>Event</th><th>Reference</th><th>Outcome</th><th>Secret verified</th></tr></thead>
        <tbody>
          {webhooks.map((w) => (
            <tr key={w.id}>
              <td className="lh-muted">{new Date(w.createdAt).toLocaleString("en-KE")}</td>
              <td><code>{w.eventType}</code></td>
              <td><code>{w.reference ?? "—"}</code></td>
              <td className="lh-muted" style={{ maxWidth: 320, overflowWrap: "anywhere" }}>{w.outcome ?? "—"}</td>
              <td>{w.signaturePresent ? "yes" : "no"}</td>
            </tr>
          ))}
          {webhooks.length === 0 && <tr><td colSpan={5} className="lh-muted">No webhook deliveries yet.</td></tr>}
        </tbody>
      </table>
    </Shell>
  );
}
