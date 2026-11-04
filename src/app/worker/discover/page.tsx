import { Shell, StatusBadge, Badge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { listOpenTasks } from "@/modules/marketplace";
import { listCatalogue } from "@/modules/opportunities";
import { ApplyForm } from "@/components/worker-forms";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Discover work — LipaHub AI" };

export default async function DiscoverPage() {
  const ctx = await getAuthContext();
  const [tasks, catalogue, myApps] = await Promise.all([
    listOpenTasks(),
    listCatalogue(),
    prisma.application.findMany({ where: { workerId: ctx!.userId }, select: { taskId: true, status: true } }),
  ]);
  const applied = new Map(myApps.map((a) => [a.taskId, a.status]));

  return (
    <Shell nav={[
      { href: "/worker", label: "Overview" },
      { href: "/worker/discover", label: "Discover work" },
      { href: "/worker/assignments", label: "My assignments" },
      { href: "/worker/rewards", label: "Rewards & withdrawals" },
    ]}>
      <h1>Discover work</h1>
      <p className="lh-muted">Open tasks are funded and rewards are held in escrow before you start. Opportunities come from external sources — always reviewed by our Trust &amp; Safety engine and human moderators.</p>

      <h2>Funded tasks from businesses</h2>
      {tasks.length === 0 ? (
        <div className="lh-card lh-muted">No open tasks right now. Check back soon.</div>
      ) : (
        tasks.map((t) => (
          <div key={t.id} className="lh-card">
            <div className="lh-row">
              <h3 style={{ margin: 0 }}>{t.title}</h3>
              <span className="lh-spacer" />
              <span className="lh-stat lh-mono" style={{ fontSize: "1.1rem" }}>{formatMoney(t.rewardMinor)}</span>
            </div>
            <p className="lh-muted">by {t.campaign.organization.name} · campaign “{t.campaign.title}” · category {t.category} · {t.slotsTotal - t.slotsTaken} slot(s) left</p>
            <details>
              <summary>Instructions &amp; requirements</summary>
              <p>{t.instructions}</p>
              <p className="lh-muted">Deliverable: {t.deliverableSpec}</p>
              <p className="lh-muted">Evidence expected: {t.evidenceRequirements.join("; ")}</p>
            </details>
            {applied.has(t.id) ? (
              <StatusBadge status={applied.get(t.id)!} />
            ) : (
              <ApplyForm taskId={t.id} />
            )}
          </div>
        ))
      )}

      <h2>External opportunity catalogue</h2>
      {catalogue.length === 0 ? (
        <div className="lh-card lh-muted">No published opportunities yet. Moderated opportunities appear here after approval.</div>
      ) : (
        catalogue.map((o) => (
          <div key={o.id} className="lh-card">
            <div className="lh-row">
              <h3 style={{ margin: 0 }}>{o.title}</h3>
              <span className="lh-spacer" />
              <Badge tone={o.riskBand === "LOW" ? "green" : o.riskBand === "MEDIUM" ? "amber" : "red"}>risk {o.riskScore} · {o.riskBand}</Badge>
            </div>
            <p>{o.description.slice(0, 280)}{o.description.length > 280 ? "…" : ""}</p>
            <p className="lh-muted">
              Source: {o.source.name}
              {o.rewardText && o.rewardText !== "Not stated" ? ` · Reward terms: ${o.rewardText}` : ""}
              {o.eligibility && o.eligibility !== "Not stated" ? ` · Eligibility: ${o.eligibility}` : ""}
              {o.geoRestrictions.length > 0 ? ` · Geo: ${o.geoRestrictions.join(", ")}` : ""}
            </p>
            {o.url && (
              <a href={o.url} target="_blank" rel="noopener noreferrer nofollow">View original listing ↗</a>
            )}
          </div>
        ))
      )}
    </Shell>
  );
}
