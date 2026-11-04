import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { formatMoney } from "@/lib/money";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employer analytics — LipaHub AI" };

export default async function AnalyticsPage() {
  const ctx = await getAuthContext();
  if (!ctx?.organizationId) {
    return <Shell nav={[]}><p className="lh-muted">No organization linked.</p></Shell>;
  }
  const orgId = ctx.organizationId;

  const [campaigns, approvedAssignments, topTasks] = await Promise.all([
    prisma.campaign.findMany({
      where: { organizationId: orgId },
      include: { tasks: { select: { id: true, status: true, rewardMinor: true, slotsTotal: true, slotsTaken: true } } },
    }),
    prisma.assignment.findMany({
      where: { task: { campaign: { organizationId: orgId } }, status: "APPROVED" },
      select: { payoutMinor: true },
    }),
    prisma.task.findMany({
      where: { campaign: { organizationId: orgId } },
      orderBy: { slotsTaken: "desc" },
      take: 5,
      select: { id: true, title: true, slotsTaken: true, slotsTotal: true, rewardMinor: true },
    }),
  ]);

  const totalPaid = approvedAssignments.reduce((acc, a) => acc + (a.payoutMinor ?? 0n), 0n);
  const commissionBps = env.finance.commissionBps;

  return (
    <Shell nav={[
      { href: "/business", label: "Campaigns" },
      { href: "/business/reviews", label: "Review submissions" },
      { href: "/business/analytics", label: "Analytics" },
    ]}>
      <h1>Employer analytics</h1>
      <div className="lh-grid lh-grid-3">
        <div className="lh-card">
          <div className="lh-stat-label">Campaigns</div>
          <div className="lh-stat">{campaigns.length}</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Approved payouts</div>
          <div className="lh-stat lh-mono">{formatMoney(totalPaid)}</div>
          <div className="lh-muted">{approvedAssignments.length} approved assignment(s)</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Slots filled</div>
          <div className="lh-stat">
            {campaigns.reduce((acc, c) => acc + c.tasks.reduce((a, t) => a + t.slotsTaken, 0), 0)}
          </div>
        </div>
      </div>

      <h2>Most popular tasks</h2>
      {topTasks.length === 0 ? (
        <div className="lh-card lh-muted">No tasks yet.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Task</th><th>Slots filled</th><th>Reward</th></tr></thead>
          <tbody>
            {topTasks.map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td>{t.slotsTaken}/{t.slotsTotal}</td>
                <td className="lh-mono">{formatMoney(t.rewardMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="lh-muted">
        Platform commission: {commissionBps / 100}% of each approved reward. All movements are visible in the ledger; this page aggregates live data, not cached estimates.
      </p>
    </Shell>
  );
}

