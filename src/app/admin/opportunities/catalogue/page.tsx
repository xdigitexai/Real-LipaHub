import { Shell, Badge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Opportunity catalogue — LipaHub AI" };

export default async function AdminCataloguePage() {
  await getAuthContext();
  const published = await prisma.discoveredOpportunity.findMany({
    where: { status: "PUBLISHED" },
    include: { source: { select: { name: true } } },
    orderBy: { fetchedAt: "desc" },
    take: 100,
  });
  const rejected = await prisma.discoveredOpportunity.count({ where: { status: "REJECTED" } });

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
      <h1>Published catalogue</h1>
      <p className="lh-muted">{published.length} published opportunity(ies) · {rejected} rejected all-time. Workers see these in <code>/worker/discover</code>.</p>
      {published.length === 0 ? (
        <div className="lh-card lh-muted">Nothing published yet.</div>
      ) : (
        published.map((o) => (
          <div key={o.id} className="lh-card">
            <div className="lh-row">
              <h3 style={{ margin: 0 }}>{o.title}</h3>
              <span className="lh-spacer" />
              <Badge tone={o.riskBand === "LOW" ? "green" : o.riskBand === "MEDIUM" ? "amber" : "red"}>risk {o.riskScore} · {o.riskBand}</Badge>
            </div>
            <p className="lh-muted">Source: {o.source.name} · approved by moderator · fetched {new Date(o.fetchedAt).toLocaleDateString("en-KE")}</p>
            {o.url && <a href={o.url} target="_blank" rel="noopener noreferrer nofollow">original ↗</a>}
          </div>
        ))
      )}
    </Shell>
  );
}
