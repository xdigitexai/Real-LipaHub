import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { escalateSubmissionAction } from "@/app/actions/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verification review — LipaHub AI" };

export default async function AdminVerificationsPage() {
  await getAuthContext();
  const needsReview = await prisma.submission.findMany({
    where: { status: "NEEDS_REVIEW" },
    include: {
      assignment: {
        include: {
          worker: { select: { name: true, email: true } },
          task: { select: { title: true, evidenceRequirements: true } },
        },
      },
      verificationRuns: { orderBy: { createdAt: "desc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

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
      <h1>Verification review (human gate)</h1>
      <p className="lh-muted">Submissions the engine could not decide with confidence. Your decision is recorded as a HUMAN verification run; the business still performs the final approval that releases money.</p>

      {needsReview.length === 0 ? (
        <div className="lh-card lh-muted">Nothing escalated right now.</div>
      ) : (
        needsReview.map((s) => (
          <div key={s.id} className="lh-card">
            <div className="lh-row">
              <h3 style={{ margin: 0 }}>{s.assignment.task.title}</h3>
              <span className="lh-spacer" />
              <StatusBadge status={s.status} />
            </div>
            <p className="lh-muted">Worker: {s.assignment.worker.name} ({s.assignment.worker.email}) · submitted {new Date(s.createdAt).toLocaleString("en-KE")}</p>
            <p className="lh-muted">Task expects: {s.assignment.task.evidenceRequirements.join("; ")}</p>
            <ul style={{ paddingLeft: "1.2rem" }}>
              {(s.evidence as Array<{ kind: string; value: string }>).map((e, i) => (
                <li key={i}>{e.kind === "link" ? <a href={e.value} target="_blank" rel="noopener noreferrer nofollow">{e.value}</a> : e.value}</li>
              ))}
            </ul>
            {s.verificationRuns.map((v) => (
              <div key={v.id} className="lh-alert" style={{ background: "var(--lh-slate-100)", color: "var(--lh-slate-700)" }}>
                <strong>{v.engine} run: {v.verdict}</strong> · confidence {v.confidence}%
                <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
                  {(v.checks as Array<{ label: string; detail: string }>).map((c, i) => (
                    <li key={i}><strong>{c.label}:</strong> {c.detail}</li>
                  ))}
                </ul>
              </div>
            ))}
            <form action={escalateSubmissionAction} className="lh-row" style={{ marginTop: "0.5rem" }}>
              <input type="hidden" name="submissionId" value={s.id} />
              <input className="lh-input" name="note" placeholder="Review note" style={{ maxWidth: 240 }} />
              <button className="lh-btn lh-btn-sm" type="submit" name="decision" value="pass">Mark verified</button>
              <button className="lh-btn lh-btn-sm lh-btn-danger" type="submit" name="decision" value="fail">Mark failed</button>
            </form>
          </div>
        ))
      )}
    </Shell>
  );
}
