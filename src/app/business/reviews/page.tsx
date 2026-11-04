import { Shell, StatusBadge } from "@/components/shell";
import { getAuthContext } from "@/lib/session-server";
import { listSubmissionsForOrg } from "@/modules/marketplace";
import { ReviewSubmissionForm } from "@/components/business-forms";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review submissions — LipaHub AI" };

export default async function ReviewsPage() {
  const ctx = await getAuthContext();
  if (!ctx?.organizationId) {
    return <Shell nav={[]}><p className="lh-muted">No organization linked to this account.</p></Shell>;
  }
  const submissions = await listSubmissionsForOrg(ctx.organizationId);

  const pending = submissions.filter((s) => ["PENDING", "AUTO_VERIFIED", "NEEDS_REVIEW"].includes(s.status));

  return (
    <Shell nav={[
      { href: "/business", label: "Campaigns" },
      { href: "/business/reviews", label: "Review submissions" },
      { href: "/business/analytics", label: "Analytics" },
    ]}>
      <h1>Review submissions</h1>
      <p className="lh-muted">
        The verification engine pre-screens every submission (completeness, link validity, duplicates).
        Verdict PASS means deterministic checks passed; NEEDS_REVIEW means a human decision is required.
        Your approval releases the escrowed reward.
      </p>

      <h2>Needs your decision ({pending.length})</h2>
      {pending.length === 0 ? (
        <div className="lh-card lh-muted">Nothing waiting — all caught up.</div>
      ) : (
        pending.map((s) => {
          const a = s.assignment;
          const latestRun = s.verificationRuns[0];
          return (
            <div key={s.id} className="lh-card">
              <div className="lh-row">
                <h3 style={{ margin: 0 }}>{a.task.title}</h3>
                <span className="lh-spacer" />
                <span>Reward <strong className="lh-mono">{formatMoney(a.task.rewardMinor)}</strong></span>
                <StatusBadge status={s.status} />
              </div>
              <p className="lh-muted">
                Worker: {a.worker.name} ({a.worker.email}) · submitted {new Date(s.createdAt).toLocaleString("en-KE")}
              </p>
              {s.notes && <p>“{s.notes}”</p>}
              <ul style={{ margin: "0.3rem 0", paddingLeft: "1.2rem" }}>
                {(s.evidence as Array<{ kind: string; label: string; value: string }>).map((e, i) => (
                  <li key={i}>
                    {e.kind === "link"
                      ? <a href={e.value} target="_blank" rel="noopener noreferrer nofollow">{e.value}</a>
                      : e.value}
                  </li>
                ))}
              </ul>
              {latestRun && (
                <div className="lh-alert" style={{ background: "var(--lh-slate-100)", color: "var(--lh-slate-700)" }}>
                  <strong>Verification engine: {latestRun.verdict}</strong> · confidence {latestRun.confidence}% · {latestRun.engine}
                  <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
                    {(latestRun.checks as Array<{ label: string; detail: string }>).map((c, i) => (
                      <li key={i}><strong>{c.label}:</strong> {c.detail}</li>
                    ))}
                  </ul>
                </div>
              )}
              <ReviewSubmissionForm submissionId={s.id} />
            </div>
          );
        })
      )}

      <h2>Decision history</h2>
      {submissions.filter((s) => ["APPROVED", "REJECTED"].includes(s.status)).length === 0 ? (
        <div className="lh-card lh-muted">No decisions yet.</div>
      ) : (
        <table className="lh-table">
          <thead><tr><th>Task</th><th>Worker</th><th>Status</th><th>Payout</th></tr></thead>
          <tbody>
            {submissions.filter((s) => ["APPROVED", "REJECTED"].includes(s.status)).map((s) => (
              <tr key={s.id}>
                <td>{s.assignment.task.title}</td>
                <td>{s.assignment.worker.name}</td>
                <td><StatusBadge status={s.status} /></td>
                <td className="lh-mono">{s.status === "APPROVED" && s.assignment.payoutMinor ? formatMoney(s.assignment.payoutMinor) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
