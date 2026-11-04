import { notFound } from "next/navigation";
import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { decideApplicationAction } from "@/app/actions/platform";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAuthContext();
  if (!ctx?.organizationId) notFound();

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      campaign: true,
      applications: {
        orderBy: { createdAt: "asc" },
        include: { worker: { select: { name: true, email: true, workerProfile: { select: { skills: true, country: true, experienceLevel: true } } } } },
      },
      assignments: { include: { worker: { select: { name: true, email: true } } } },
    },
  });
  if (!task || task.campaign.organizationId !== ctx.organizationId) notFound();

  return (
    <Shell nav={[
      { href: "/business", label: "Campaigns" },
      { href: "/business/reviews", label: "Review submissions" },
      { href: "/business/analytics", label: "Analytics" },
    ]}>
      <p><a href={`/business/campaigns/${task.campaign.id}`}>← {task.campaign.title}</a></p>
      <h1>{task.title}</h1>
      <p className="lh-row">
        <StatusBadge status={task.status} />
        <span>Reward <strong className="lh-mono">{formatMoney(task.rewardMinor)}</strong></span>
        <span>· Slots {task.slotsTaken}/{task.slotsTotal}</span>
      </p>
      <div className="lh-card">
        <h3 style={{ marginTop: 0 }}>Instructions</h3>
        <p style={{ whiteSpace: "pre-wrap" }}>{task.instructions}</p>
        <p className="lh-muted">Deliverable: {task.deliverableSpec} · Evidence: {task.evidenceRequirements.join("; ")}</p>
      </div>

      <h2>Applications</h2>
      {task.applications.filter((a) => a.status === "PENDING").length === 0 ? (
        <div className="lh-card lh-muted">No pending applications.</div>
      ) : (
        task.applications.filter((a) => a.status === "PENDING").map((a) => (
          <div key={a.id} className="lh-card">
            <strong>{a.worker.name}</strong> <span className="lh-muted">{a.worker.email}</span>
            <p className="lh-muted">
              {a.worker.workerProfile?.country} · {a.worker.workerProfile?.experienceLevel}
              {a.worker.workerProfile?.skills.length ? ` · skills: ${a.worker.workerProfile.skills.join(", ")}` : ""}
            </p>
            {a.message && <p>“{a.message}”</p>}
            <form action={decideApplicationAction} className="lh-row">
              <input type="hidden" name="applicationId" value={a.id} />
              <input type="hidden" name="taskId" value={task.id} />
              <button className="lh-btn lh-btn-sm" type="submit" name="decision" value="accept">Accept &amp; assign</button>
              <button className="lh-btn lh-btn-sm lh-btn-secondary" type="submit" name="decision" value="reject">Reject</button>
            </form>
          </div>
        ))
      )}

      <h2>Assignments</h2>
      {task.assignments.length === 0 ? (
        <div className="lh-card lh-muted">No assignments yet.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Worker</th><th>Status</th><th>Deadline</th><th>Payout</th></tr></thead>
          <tbody>
            {task.assignments.map((a) => (
              <tr key={a.id}>
                <td>{a.worker.name}</td>
                <td><StatusBadge status={a.status} /></td>
                <td>{a.deadlineAt ? new Date(a.deadlineAt).toLocaleDateString("en-KE") : "—"}</td>
                <td className="lh-mono">{a.payoutMinor ? formatMoney(a.payoutMinor) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
