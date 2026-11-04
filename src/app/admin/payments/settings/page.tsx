import { Shell } from "@/components/shell";
import { getAuthContext } from "@/lib/session-server";
import { getProviderConfigStatus, getEnabledGateways, getRecommendedGateway, getWithdrawalPolicy, WITHDRAWAL_FEE_PERCENT } from "@/modules/payments";
import { PaymentSettingsForm, TestConnectionForm } from "@/components/admin-payment-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment settings — LipaHub AI" };

export default async function AdminPaymentSettingsPage() {
  await getAuthContext();
  const cfg = await getProviderConfigStatus();
  const gateways = await getEnabledGateways();
  const recommended = await getRecommendedGateway();
  const policy = await getWithdrawalPolicy();

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
      <h1>Payment provider settings</h1>

      <div className="lh-card">
        <h3 style={{ marginTop: 0 }}>Provider configuration (Xdigitex Pay)</h3>
        <table className="lh-table">
          <tbody>
            <tr><td>API key</td><td>{cfg.configured ? <span className="lh-badge lh-badge-green">configured — held server-side, never displayed</span> : <span className="lh-badge lh-badge-amber">not configured (sandbox mode)</span>}</td></tr>
            <tr><td>Base URL</td><td><code>{cfg.baseUrl}</code></td></tr>
            <tr><td>Webhook secret</td><td>{cfg.webhookSecretSet ? <span className="lh-badge lh-badge-green">set — webhook requests must carry X-Webhook-Secret</span> : <span className="lh-badge lh-badge-slate">not set — payloads still verified via status endpoint</span>}</td></tr>
            <tr><td>Public URL (callback/webhook base)</td><td><code>{cfg.appPublicUrl}</code></td></tr>
            <tr><td>Webhook endpoint</td><td><code>{cfg.appPublicUrl}/api/webhooks/xdigitex</code></td></tr>
            <tr><td>Documented withdrawal fee</td><td>{WITHDRAWAL_FEE_PERCENT}% (shown to workers before confirmation; actual fee confirmed by provider)</td></tr>
          </tbody>
        </table>
        <div className="lh-muted" style={{ marginTop: "0.5rem" }}>
          To rotate the key: set <code>XDIGITEX_PAY_API_KEY</code> (and optionally <code>XDIGITEX_PAY_WEBHOOK_SECRET</code>, <code>XDIGITEX_PAY_BASE_URL</code>) in the server environment and restart. Keys are read from env only — never from the database or client.
        </div>
        <div style={{ marginTop: "0.8rem" }}>
          <TestConnectionForm />
        </div>
      </div>

      <div className="lh-card">
        <h3 style={{ marginTop: 0 }}>Payment methods &amp; withdrawal policy</h3>
        <PaymentSettingsForm
          gateways={gateways}
          recommended={recommended}
          minUnits={Number(policy.minMinor) / 100}
          maxUnits={Number(policy.maxMinor) / 100}
        />
      </div>
    </Shell>
  );
}
