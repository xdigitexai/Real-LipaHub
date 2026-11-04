import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { listCampaignsForOrg } from "@/modules/marketplace";
import { campaignHeldBalance, orgWalletBalance } from "@/modules/finance";
import { isXdigitexConfigured, getEnabledGateways, getRecommendedGateway } from "@/modules/payments";
import { formatMoney } from "@/lib/money";
import { CreateCampaignForm } from "@/components/business-forms";
import { DepositForm } from "@/components/payment-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Business dashboard — LipaHub AI" };

export default async function BusinessOverview() {
  const ctx = await getAuthContext();
  const org = await requireOrgOrRedirect();
  const campaigns = await listCampaignsForOrg(org.id);

  const heldBalances = await prisma.$transaction(async (tx) => {
    const map = new Map<string, bigint>();
    for (const c of campaigns) {
      map.set(c.id, await campaignHeldBalance(tx, c.id));
    }
    return map;
  });

  const wallet = await prisma.$transaction(async (tx) => orgWalletBalance(tx, org.id));
  const providerConfigured = isXdigitexConfigured();
  const gateways = providerConfigured ? await getEnabledGateways() : [];
  const recommended = await getRecommendedGateway();

  const pendingSubmissions = await prisma.submission.count({
    where: { assignment: { task: { campaign: { organizationId: org.id } } }, status: { in: ["PENDING", "AUTO_VERIFIED", "NEEDS_REVIEW"] } },
  });
  const pendingApplications = await prisma.application.count({
    where: { status: "PENDING", task: { campaign: { organizationId: org.id } } },
  });

  return (
    <Shell nav={[
      { href: "/business", label: "Campaigns" },
      { href: "/business/reviews", label: "Review submissions" },
      { href: "/business/analytics", label: "Analytics" },
    ]}>
      <h1>Business dashboard</h1>
      <p className="lh-muted">
        Organization: <strong>{org.name}</strong> · <StatusBadge status={org.verificationStatus} />
        {org.verificationStatus !== "VERIFIED" && (
          <span> — an administrator must verify your organization before you can fund campaigns.</span>
        )}
      </p>

      <div className="lh-grid lh-grid-3">
        <div className="lh-card">
          <div className="lh-stat-label">Organization wallet</div>
          <div className="lh-stat lh-mono">{formatMoney(wallet, org.currency)}</div>
          <div className="lh-muted">Deposits land here after provider verification; campaigns are funded from this wallet.</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Campaigns</div>
          <div className="lh-stat">{campaigns.length}</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Pending applications</div>
          <div className="lh-stat">{pendingApplications}</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Submissions to review</div>
          <div className="lh-stat">{pendingSubmissions}</div>
          <a href="/business/reviews">Review now →</a>
        </div>
      </div>

      <h2>Deposit to organization wallet</h2>
      <div className="lh-card">
        {org.verificationStatus !== "VERIFIED" ? (
          <p className="lh-muted">Your organization must be verified before depositing.</p>
        ) : providerConfigured ? (
          <>
            <p className="lh-muted">Payments are processed by <strong>Xdigitex Pay</strong> (server-side, key never exposed). Mobile-money confirmations land automatically once the provider verifies the transaction.</p>
            <DepositForm gateways={gateways} recommended={recommended} currency={org.currency} />
          </>
        ) : (
          <>
            <div className="lh-alert lh-alert-warn">
              <strong>Sandbox mode</strong> — no payment provider API key is configured. Campaign funding via the campaign page is instant and simulated; it never touches real money. Configure <code>XDIGITEX_PAY_API_KEY</code> to enable real deposits to this wallet.
            </div>
            <p className="lh-muted">Open a campaign below to fund it in sandbox mode.</p>
          </>
        )}
      </div>

      <h2>Campaigns</h2>
      {campaigns.length === 0 ? (
        <div className="lh-card lh-muted">No campaigns yet — create your first one below.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Campaign</th><th>Budget</th><th>Held (unreserved)</th><th>Tasks</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>{c.title}<div className="lh-muted">{c.category}</div></td>
                <td className="lh-mono">{formatMoney(c.budgetMinor)}</td>
                <td className="lh-mono">{formatMoney(heldBalances.get(c.id) ?? 0n)}</td>
                <td>{c.tasks.length}</td>
                <td><StatusBadge status={c.status} /></td>
                <td><a href={`/business/campaigns/${c.id}`}>Open →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Create a campaign</h2>
      <div className="lh-card">
        {org.verificationStatus === "VERIFIED" ? (
          <CreateCampaignForm />
        ) : (
          <p className="lh-muted">Your organization must be verified by a LipaHub administrator before creating campaigns.</p>
        )}
      </div>
    </Shell>
  );
}

async function requireOrgOrRedirect() {
  const ctx = await getAuthContext();
  if (!ctx?.organizationId) throw new Error("No organization linked to this account");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  return org;
}
