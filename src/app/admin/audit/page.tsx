import { Shell } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log — LipaHub AI" };

export default async function AdminAuditPage() {
  await getAuthContext();
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 150,
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
      <h1>Audit log</h1>
      <p className="lh-muted">Append-only trail of authentication, financial, moderation and marketplace actions.</p>
      <table className="lh-table">
        <thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Actor role</th><th>Metadata</th></tr></thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="lh-muted">{new Date(l.createdAt).toLocaleString("en-KE")}</td>
              <td><code>{l.action}</code></td>
              <td className="lh-muted">{l.entityType}:{(l.entityId ?? "").slice(0, 10)}</td>
              <td className="lh-muted">{l.actorRole ?? "system"}</td>
              <td className="lh-muted" style={{ maxWidth: 320, overflowWrap: "anywhere" }}>
                {l.metadata ? JSON.stringify(l.metadata).slice(0, 140) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Shell>
  );
}
