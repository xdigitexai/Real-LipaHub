import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { workerPayableBalance } from "@/modules/finance";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function WorkerOverview() {
  const ctx = await getAuthContext();
  const workerId = ctx!.userId;

  const [activeAssignments, openApps, payable, submissions, notifications] = await Promise.all([
    prisma.assignment.count({ where: { workerId, status: { in: ["ACTIVE", "SUBMITTED", "IN_REVIEW"] } } }),
    prisma.application.count({ where: { workerId, status: "PENDING" } }),
    prisma.$transaction((tx) => workerPayableBalance(tx, workerId)),
    prisma.assignment.findMany({
      where: { workerId },
      orderBy: { createdAt: "desc" },
      include: { task: { select: { title: true, rewardMinor: true } } },
      take: 8,
    }),
    prisma.notification.findMany({ where: { userId: workerId }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  const approved = submissions.filter((a) => a.status === "APPROVED").length;

  return (
    <Shell nav={[
      { href: "/worker", label: "Overview" },
      { href: "/worker/discover", label: "Discover work" },
      { href: "/worker/assignments", label: "My assignments" },
      { href: "/worker/rewards", label: "Rewards & withdrawals" },
    ]}>
      <h1>Worker dashboard</h1>
      <p className="lh-muted">Find legitimate work, complete it well, get verified, get paid. LipaHub never promises income — earnings reflect the work you complete.</p>

      <div className="lh-grid lh-grid-3" style={{ marginTop: "1rem" }}>
        <div className="lh-card">
          <div className="lh-stat-label">Reward balance</div>
          <div className="lh-stat lh-mono">{formatMoney(payable)}</div>
          <a href="/worker/rewards">Rewards &amp; withdrawals →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Active assignments</div>
          <div className="lh-stat">{activeAssignments}</div>
          <a href="/worker/assignments">My assignments →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Pending applications</div>
          <div className="lh-stat">{openApps}</div>
          <a href="/worker/discover">Discover work →</a>
        </div>
        <div className="lh-card">
          <div className="lh-stat-label">Approved works</div>
          <div className="lh-stat">{approved}</div>
          <div className="lh-muted">All time</div>
        </div>
      </div>

      <h2>Recent assignments</h2>
      {submissions.length === 0 ? (
        <div className="lh-card lh-muted">No assignments yet — <a href="/worker/discover">discover open work</a> and apply.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Task</th><th>Reward</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {submissions.map((a) => (
              <tr key={a.id}>
                <td>{a.task.title}</td>
                <td className="lh-mono">{formatMoney(a.task.rewardMinor)}</td>
                <td><StatusBadge status={a.status} /></td>
                <td><a href={`/worker/assignments/${a.id}`}>Open →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {notifications.length > 0 && (
        <>
          <h2>Latest notifications</h2>
          {notifications.map((n) => (
            <div key={n.id} className="lh-card">
              <strong>{n.title}</strong>
              <p className="lh-muted">{n.body}</p>
            </div>
          ))}
        </>
      )}
    </Shell>
  );
}

export const metadata = { title: "Worker dashboard — LipaHub AI" };
