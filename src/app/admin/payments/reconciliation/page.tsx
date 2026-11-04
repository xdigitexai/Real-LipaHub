import { Shell } from "@/components/shell";
import { getAuthContext } from "@/lib/session-server";
import { getReconciliationSnapshot } from "@/modules/payments";
import { formatMoney } from "@/lib/money";
import { RetryReconciliationForm } from "@/components/admin-payment-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment reconciliation — LipaHub AI" };

export default async function AdminReconciliationPage() {
  await getAuthContext();
  const snapshot = await getReconciliationSnapshot();
  const internal = snapshot.internal;
  const delta = snapshot.deltaMinor;

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
      <h1>Financial reconciliation</h1>
      <div className="lh-alert lh-alert-info">
        The internal double-entry ledger is the <strong>source of truth for user balances</strong>.
        The provider wallet is an external mirror of cash held at the payment provider — a difference
        between the two requires investigation, it is never reconciled by force.
      </div>

      <div className="lh-grid lh-grid-2">
        <div className="lh-card">
          <h3 style={{ marginTop: 0 }}>Provider wallet (Xdigitex Pay)</h3>
          {snapshot.provider ? (
            <table className="lh-table">
              <tbody>
                <tr><td>Balance</td><td className="lh-mono">{snapshot.provider.balance.toFixed(2)} {snapshot.provider.currency}</td></tr>
                <tr><td>Locked</td><td className="lh-mono">{snapshot.provider.lockedBalance ?? "—"}</td></tr>
                <tr><td>Available</td><td className="lh-mono">{snapshot.provider.availableBalance ?? "—"}</td></tr>
              </tbody>
            </table>
          ) : (
            <p className="lh-muted">{snapshot.providerError ?? "Provider not configured."}</p>
          )}
        </div>
        <div className="lh-card">
          <h3 style={{ marginTop: 0 }}>Internal platform ledger</h3>
          <table className="lh-table">
            <tbody>
              <tr><td>provider-clearing account</td><td className="lh-mono">{formatMoney(internal.providerClearingBalanceMinor)}</td></tr>
              <tr><td>Completed deposits (gross)</td><td className="lh-mono">{formatMoney(internal.completedDepositsMinor)}</td></tr>
              <tr><td>Deposit fees (provider-retained)</td><td className="lh-mono">{formatMoney(internal.depositFeesMinor)}</td></tr>
              <tr><td>Completed withdrawals (gross)</td><td className="lh-mono">{formatMoney(internal.completedWithdrawalsMinor)}</td></tr>
              <tr><td>Withdrawal fees (provider-retained)</td><td className="lh-mono">{formatMoney(internal.withdrawalFeesMinor)}</td></tr>
              <tr><td>Pending transactions</td><td className="lh-mono">{internal.pendingPayments}</td></tr>
              <tr><td>Uncertain transactions</td><td className="lh-mono">{internal.uncertainPayments}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className={`lh-alert ${delta === null ? "lh-alert-warn" : delta === 0n ? "lh-alert-info" : "lh-alert-error"}`}>
        {delta === null
          ? "Delta unavailable (provider wallet not readable)."
          : delta === 0n
            ? "Provider wallet matches internal provider-clearing balance ✓"
            : `Δ provider vs internal: ${formatMoney(delta)} — investigate unmatched references, fees in transit, or locked balances.`}
      </div>

      <div className="lh-card">
        <h3 style={{ marginTop: 0 }}>Safe reconciliation sweep</h3>
        <RetryReconciliationForm />
      </div>

      <div className="lh-card">
        <h3 style={{ marginTop: 0 }}>How reconciliation works</h3>
        <ul style={{ lineHeight: 1.8 }}>
          <li><strong>Deposits:</strong> every pending deposit is verified against <code>GET /payments/&#123;reference&#125;/status</code>; completed payments are credited only when reference, amount and currency all match.</li>
          <li><strong>Withdrawals:</strong> no single-withdrawal status endpoint is documented, so pending withdrawals are matched in the paginated <code>GET /withdrawals</code> history. References absent from history for 30+ minutes become <strong>UNCERTAIN</strong> for admin review — they are never resubmitted automatically.</li>
          <li><strong>Mismatches</strong> (amount/currency differ from the provider) are flagged UNCERTAIN and never credited.</li>
        </ul>
      </div>
    </Shell>
  );
}
