import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { formatMoney } from "@/lib/money";
import { queueDepth } from "@/jobs/pg-queue";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin — LipaHub AI" };

export default async function AdminOverview() {
  const ctx = await getAuthContext();

  const [users, orgsPending, oppsPending, oppsPublished, agentRunsRecent, failedJobs, withdrawalsPending, revenue, tasksOpen] = await Promise.all([
    prisma.user.count(),
    prisma.organization.count({ where: { verificationStatus: "PENDING" } }),
    prisma.discoveredOpportunity.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.discoveredOpportunity.count({ where: { status: "PUBLISHED" } }),
    prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
    queueDepth("discovery").catch(() => -1),
    prisma.withdrawalRequest.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.ledgerEntry.aggregate({ where: { accountCode: "platform-revenue" }, _sum: { amountMinor: true } }),
    prisma.task.count({ where: { status: "OPEN" } }),
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
      <h1>Administration</h1>
      <p className="lh-muted">Signed in as {ctx!.name} — full platform oversight with audit trails.</p>

      <div className="lh-grid lh-grid-3">
        <div className="lh-card">
          <div className="lh-stat-label">Users</div>
          <div className="lh-stat">{users}</div>
          <a href="/admin/users">Manage →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Orgs awaiting verification</div>
          <div className="lh-stat">{orgsPending}</div>
          <a href="/admin/users">Verify →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Moderation queue</div>
          <div className="lh-stat">{oppsPending}</div>
          <a href="/admin/opportunities/moderation">Review →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Published opportunities</div>
          <div className="lh-stat">{oppsPublished}</div>
          <a href="/admin/opportunities/catalogue">Catalogue →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Withdrawals to review</div>
          <div className="lh-stat">{withdrawalsPending}</div>
          <a href="/admin/withdrawals">Review →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Platform revenue</div>
          <div className="lh-stat lh-mono">{formatMoney(revenue._sum.amountMinor ?? 0n)}</div>
          <div className="lh-muted">Commission from approved rewards</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Open tasks</div>
          <div className="lh-stat">{tasksOpen}</div>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Discovery queue depth</div>
          <div className="lh-stat">{failedJobs < 0 ? "n/a" : failedJobs}</div>
          <div className="lh-muted">PostgreSQL-backed queue</div>
        </div>
      </div>

      <h2>Recent AI agent runs</h2>
      {agentRunsRecent.length === 0 ? (
        <div className="lh-card lh-muted">No agent runs yet.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Agent</th><th>Status</th><th>Model</th><th>Tokens</th><th>When</th></tr></thead>
          <tbody>
            {agentRunsRecent.map((r) => (
              <tr key={r.id}>
                <td>{r.agent}</td>
                <td><StatusBadge status={r.status} /></td>
                <td className="lh-muted">{r.model ?? "—"}</td>
                <td className="lh-mono">{r.tokensIn}/{r.tokensOut}</td>
                <td className="lh-muted">{new Date(r.createdAt).toLocaleString("en-KE")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p><a href="/admin/agents">All agent runs →</a></p>
    </Shell>
  );
}
