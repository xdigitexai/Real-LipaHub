import { notFound } from "next/navigation";
import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { campaignHeldBalance, orgWalletBalance } from "@/modules/finance";
import { isXdigitexConfigured } from "@/modules/payments";
import { formatMoney } from "@/lib/money";
import { FundCampaignForm, CreateTaskForm } from "@/components/business-forms";
import { FundFromWalletForm } from "@/components/payment-forms";
import { publishTaskAction, cancelTaskAction } from "@/app/actions/platform";

export const dynamic = "force-dynamic";

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAuthContext();
  if (!ctx?.organizationId) notFound();
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { tasks: { orderBy: { createdAt: "desc" } }, fundingRecords: { orderBy: { createdAt: "desc" } } },
  });
  if (!campaign || campaign.organizationId !== ctx.organizationId) notFound();

  const [held, wallet, providerConfigured] = await Promise.all([
    prisma.$transaction((tx) => campaignHeldBalance(tx, campaign.id)),
    prisma.$transaction((tx) => orgWalletBalance(tx, ctx.organizationId!)),
    Promise.resolve(isXdigitexConfigured()),
  ]);

  return (
    <Shell nav={[
      { href: "/business", label: "Campaigns" },
      { href: "/business/reviews", label: "Review submissions" },
      { href: "/business/analytics", label: "Analytics" },
    ]}>
      <p><a href="/business">← All campaigns</a></p>
      <h1>{campaign.title}</h1>
      <p className="lh-muted">{campaign.description}</p>
      <p className="lh-row">
        <StatusBadge status={campaign.status} />
        <span>Category: {campaign.category}</span>
        <span>· Budget: <strong className="lh-mono">{formatMoney(campaign.budgetMinor)}</strong></span>
        <span>· Held (unreserved): <strong className="lh-mono">{formatMoney(held)}</strong></span>
      </p>

      <div className="lh-grid lh-grid-2">
        <div className="lh-card">
          <h3 style={{ marginTop: 0 }}>Fund this campaign</h3>
          {providerConfigured ? (
            <>
              <p className="lh-muted">Funding moves money from your organization wallet into “campaign funds held”. Publishing payable tasks reserves rewards from this balance (escrow).</p>
              <FundFromWalletForm campaignId={campaign.id} walletBalance={Number(wallet) / 100} currency={campaign.currency} />
            </>
          ) : (
            <>
              <p className="lh-muted"><strong>Sandbox mode</strong> — simulated instant funding, no real money. Publishing payable tasks reserves rewards from this balance (escrow).</p>
              <FundCampaignForm campaignId={campaign.id} />
            </>
          )}
        </div>
        <div className="lh-card">
          <h3 style={{ marginTop: 0 }}>Funding history</h3>
          {campaign.fundingRecords.length === 0 ? (
            <p className="lh-muted">No funding yet.</p>
          ) : (
            <table className="lh-table">
              <thead><tr><th>Date</th><th>Amount</th><th>Provider</th><th>Status</th></tr></thead>
              <tbody>
                {campaign.fundingRecords.map((f) => (
                  <tr key={f.id}>
                    <td>{new Date(f.createdAt).toLocaleString("en-KE")}</td>
                    <td className="lh-mono">{formatMoney(f.amountMinor)}</td>
                    <td>{f.provider}</td>
                    <td><StatusBadge status={f.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <h2>Tasks</h2>
      {campaign.tasks.length === 0 ? (
        <div className="lh-card lh-muted">No tasks yet — create the first one below.</div>
      ) : (
        campaign.tasks.map((t) => (
          <div key={t.id} className="lh-card">
            <div className="lh-row">
              <h3 style={{ margin: 0 }}>{t.title}</h3>
              <span className="lh-spacer" />
              <span className="lh-mono"><strong>{formatMoney(t.rewardMinor)}</strong> × {t.slotsTotal} slot(s)</span>
              <StatusBadge status={t.status} />
            </div>
            <p className="lh-muted">Deliverable: {t.deliverableSpec} · taken {t.slotsTaken}/{t.slotsTotal}</p>
            <div className="lh-row">
              <a className="lh-btn lh-btn-sm lh-btn-secondary" href={`/business/tasks/${t.id}`}>
                {t.status === "OPEN" || t.status === "IN_PROGRESS" ? "Applications & assignments" : "Details"}
              </a>
              {(t.status === "DRAFT" || t.status === "PENDING_FUNDING") && (
                <form action={publishTaskAction}>
                  <input type="hidden" name="taskId" value={t.id} />
                  <input type="hidden" name="campaignId" value={campaign.id} />
                  <button className="lh-btn lh-btn-sm" type="submit">
                    Publish &amp; reserve {formatMoney(t.rewardMinor * BigInt(t.slotsTotal))}
                  </button>
                </form>
              )}
              {!["COMPLETED", "CANCELLED"].includes(t.status) && (
                <form action={cancelTaskAction}>
                  <input type="hidden" name="taskId" value={t.id} />
                  <input type="hidden" name="campaignId" value={campaign.id} />
                  <button className="lh-btn lh-btn-sm lh-btn-danger" type="submit">Cancel</button>
                </form>
              )}
            </div>
          </div>
        ))
      )}

      <h2>Create a task</h2>
      <div className="lh-card">
        {["DRAFT", "FUNDED", "ACTIVE", "PAUSED"].includes(campaign.status) ? (
          <CreateTaskForm campaignId={campaign.id} />
        ) : (
          <p className="lh-muted">This campaign no longer accepts new tasks.</p>
        )}
      </div>
    </Shell>
  );
}
