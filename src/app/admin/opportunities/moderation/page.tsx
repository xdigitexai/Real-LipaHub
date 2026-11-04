import { Shell, StatusBadge, Badge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { moderateOpportunityAction } from "@/app/actions/platform";

export const dynamic = "force-dynamic";
export const metadata = { title: "Moderation queue — LipaHub AI" };

interface RiskSignal { signal: string; severity: string; explanation: string }

export default async function ModerationPage() {
  const ctx = await getAuthContext();
  const queue = await prisma.discoveredOpportunity.findMany({
    where: { status: "PENDING_REVIEW" },
    include: { source: { select: { name: true, trustLevel: true } } },
    orderBy: { riskScore: "desc" },
    take: 200,
  });

  return (
    <Shell nav={[
      { href: "/admin", label: "Overview" },
      { href: "/admin/opportunities/sources", label: "Opportunity sources" },
      { href: "/admin/opportunities/moderation", label: "Moderation queue" },
      { href: "/admin/opportunities/catalogue", label: "Catalogue" },
      { href: "/admin/users", label: "Users & organizations" },
      { href: "/admin/withdrawals", label: "Withdrawals" },
      { href: "/admin/ledger", label: "Ledger" },
      { href: "/admin/agents", label: "AI agents" },
      { href: "/admin/audit", label: "Audit log" },
    ]}>
      <h1>Moderation queue</h1>
      <p className="lh-muted">
        Every AI-discovered opportunity waits here for a human decision. CRITICAL-risk items are
        auto-flagged with a rejection recommendation, but <strong>you decide</strong> — nothing is
        auto-published, nothing is auto-rejected.
      </p>

      {queue.length === 0 ? (
        <div className="lh-card lh-muted">Queue is empty — run discovery from a source to populate it.</div>
      ) : (
        queue.map((o) => {
          const signals = (o.riskSignals as RiskSignal[] | null) ?? [];
          const aiRun = o.aiRunId ? null : null;
          void aiRun;
          return (
            <div key={o.id} className="lh-card">
              <div className="lh-row">
                <h3 style={{ margin: 0 }}>{o.title}</h3>
                <span className="lh-spacer" />
                <Badge tone={o.riskBand === "LOW" ? "green" : o.riskBand === "MEDIUM" ? "amber" : "red"}>
                  risk {o.riskScore} · {o.riskBand}
                </Badge>
                <span className="lh-muted">confidence {o.confidence}%</span>
              </div>
              <p>{o.description.slice(0, 500)}{o.description.length > 500 ? "…" : ""}</p>
              <p className="lh-muted">
                Source: {o.source.name} ({o.source.trustLevel}) · fetched {new Date(o.fetchedAt).toLocaleString("en-KE")}
                {o.rewardText && o.rewardText !== "Not stated" ? ` · Reward: ${o.rewardText}` : ""}
                {o.eligibility && o.eligibility !== "Not stated" ? ` · Eligibility: ${o.eligibility}` : ""}
                {o.geoRestrictions.length > 0 ? ` · Geo: ${o.geoRestrictions.join(", ")}` : ""}
                {o.url ? ` · ` : ""}
                {o.url && <a href={o.url} target="_blank" rel="noopener noreferrer nofollow">original ↗</a>}
              </p>
              {signals.length > 0 && (
                <details open={o.riskBand === "CRITICAL" || o.riskBand === "HIGH"}>
                  <summary>Risk signals ({signals.length})</summary>
                  <ul style={{ margin: "0.4rem 0", paddingLeft: "1.2rem" }}>
                    {signals.map((s, i) => (
                      <li key={i}>
                        <strong>{s.signal}</strong> <StatusBadge status={s.severity === "CRITICAL" ? "CRITICAL" : s.severity === "WARNING" ? "PENDING" : "ACTIVE"} /> — {s.explanation}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {o.reviewNote && <p className="lh-alert lh-alert-warn">{o.reviewNote}</p>}
              <form action={moderateOpportunityAction} className="lh-row" style={{ marginTop: "0.5rem" }}>
                <input type="hidden" name="opportunityId" value={o.id} />
                <input type="hidden" name="decision" value="approve" />
                <input className="lh-input" name="note" placeholder="Optional review note" style={{ maxWidth: 260 }} />
                <button className="lh-btn lh-btn-sm" type="submit">Approve &amp; publish</button>
              </form>
              <form action={moderateOpportunityAction} className="lh-row" style={{ marginTop: "0.4rem" }}>
                <input type="hidden" name="opportunityId" value={o.id} />
                <input type="hidden" name="decision" value="reject" />
                <input className="lh-input" name="note" placeholder="Rejection reason" style={{ maxWidth: 260 }} required />
                <button className="lh-btn lh-btn-sm lh-btn-danger" type="submit">Reject</button>
              </form>
            </div>
          );
        })
      )}
    </Shell>
  );
}
