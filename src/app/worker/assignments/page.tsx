import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "My assignments — LipaHub AI" };

export default async function AssignmentsPage() {
  const ctx = await getAuthContext();
  const assignments = await prisma.assignment.findMany({
    where: { workerId: ctx!.userId },
    orderBy: { createdAt: "desc" },
    include: {
      task: { select: { id: true, title: true, rewardMinor: true, status: true } },
      submissions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return (
    <Shell nav={[
      { href: "/worker", label: "Overview" },
      { href: "/worker/discover", label: "Discover work" },
      { href: "/worker/assignments", label: "My assignments" },
      { href: "/worker/rewards", label: "Rewards & withdrawals" },
    ]}>
      <h1>My assignments</h1>
      {assignments.length === 0 ? (
        <div className="lh-card lh-muted">No assignments yet. <a href="/worker/discover">Discover open work →</a></div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Task</th><th>Reward</th><th>Assignment</th><th>Submission</th><th></th></tr></thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id}>
                <td>{a.task.title}<div className="lh-muted">Deadline: {a.deadlineAt ? new Date(a.deadlineAt).toLocaleDateString("en-KE") : "—"}</div></td>
                <td className="lh-mono">{formatMoney(a.task.rewardMinor)}</td>
                <td><StatusBadge status={a.status} /></td>
                <td>{a.submissions[0] ? <StatusBadge status={a.submissions[0].status} /> : <span className="lh-muted">none</span>}</td>
                <td><a href={`/worker/assignments/${a.id}`}>Open →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
