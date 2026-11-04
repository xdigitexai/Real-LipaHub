import { notFound } from "next/navigation";
import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { SubmitWorkForm } from "@/components/worker-forms";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function AssignmentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAuthContext();
  const assignment = await prisma.assignment.findUnique({
    where: { id },
    include: {
      task: { include: { campaign: { select: { title: true, organization: { select: { name: true } } } } } },
      submissions: { orderBy: { createdAt: "desc" }, include: { verificationRuns: { orderBy: { createdAt: "desc" } } } },
    },
  });
  if (!assignment || assignment.workerId !== ctx!.userId) notFound();

  const latest = assignment.submissions[0];

  return (
    <Shell nav={[
      { href: "/worker", label: "Overview" },
      { href: "/worker/discover", label: "Discover work" },
      { href: "/worker/assignments", label: "My assignments" },
      { href: "/worker/rewards", label: "Rewards & withdrawals" },
    ]}>
      <p><a href="/worker/assignments">← All assignments</a></p>
      <h1>{assignment.task.title}</h1>
      <p className="lh-muted">
        {assignment.task.campaign.organization.name} · campaign “{assignment.task.campaign.title}” ·
        reward <strong className="lh-mono">{formatMoney(assignment.task.rewardMinor)}</strong> ·
        status <StatusBadge status={assignment.status} />
        {assignment.deadlineAt ? ` · due ${new Date(assignment.deadlineAt).toLocaleDateString("en-KE")}` : ""}
      </p>

      <div className="lh-card">
        <h2 style={{ marginTop: 0 }}>Instructions</h2>
        <p style={{ whiteSpace: "pre-wrap" }}>{assignment.task.instructions}</p>
        <p><strong>Deliverable:</strong> {assignment.task.deliverableSpec}</p>
        <p className="lh-muted">Evidence expected: {assignment.task.evidenceRequirements.join("; ")}</p>
      </div>

      {assignment.status === "ACTIVE" && (
        <div className="lh-card">
          <h2 style={{ marginTop: 0 }}>Submit your work</h2>
          <SubmitWorkForm assignmentId={assignment.id} evidenceRequirements={assignment.task.evidenceRequirements} />
        </div>
      )}

      {latest && (
        <div className="lh-card">
          <h2 style={{ marginTop: 0 }}>Submissions &amp; verification</h2>
          {assignment.submissions.map((s) => (
            <div key={s.id} style={{ marginBottom: "0.8rem" }}>
              <div className="lh-row">
                <StatusBadge status={s.status} />
                <span className="lh-muted">{new Date(s.createdAt).toLocaleString("en-KE")}</span>
              </div>
              {s.notes && <p>{s.notes}</p>}
              {s.verificationRuns.map((v) => (
                <div key={v.id} className="lh-alert" style={{ background: "var(--lh-slate-100)", color: "var(--lh-slate-700)" }}>
                  <strong>Verification: {v.verdict}</strong> · confidence {v.confidence}% · engine {v.engine} {v.escalated ? "· escalated to human review" : ""}
                  <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
                    {(v.checks as Array<{ label: string; detail: string; passed: boolean | null }>).map((c, i) => (
                      <li key={i}><strong>{c.label}:</strong> {c.detail}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {assignment.status === "REJECTED" && (
        <div className="lh-alert lh-alert-warn">
          This submission was rejected by the business. Check the rejection explanation in your notifications, and open a dispute if you believe it is wrong.
        </div>
      )}
      {assignment.status === "APPROVED" && (
        <div className="lh-alert lh-alert-info">
          Approved — the reward was released to your ledger. See <a href="/worker/rewards">Rewards &amp; withdrawals</a>.
        </div>
      )}
    </Shell>
  );
}
