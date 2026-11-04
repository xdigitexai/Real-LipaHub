import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { verifyOrganizationAction } from "@/app/actions/platform";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users & organizations — LipaHub AI" };

export default async function AdminUsersPage() {
  await getAuthContext();
  const [orgs, users] = await Promise.all([
    prisma.organization.findMany({ orderBy: { createdAt: "desc" }, include: { owner: { select: { name: true, email: true } } } }),
    prisma.user.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, email: true, role: true, status: true, createdAt: true } }),
  ]);

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
      <h1>Users &amp; organizations</h1>

      <h2>Organizations</h2>
      {orgs.length === 0 ? (
        <div className="lh-card lh-muted">No organizations registered yet.</div>
      ) : (
        orgs.map((o) => (
          <div key={o.id} className="lh-card">
            <div className="lh-row">
              <strong>{o.name}</strong>
              <StatusBadge status={o.verificationStatus} />
              <span className="lh-spacer" />
              <span className="lh-muted">owner: {o.owner.name} ({o.owner.email})</span>
            </div>
            {o.verificationNote && <p className="lh-muted">Note: {o.verificationNote}</p>}
            <form action={verifyOrganizationAction} className="lh-row" style={{ marginTop: "0.4rem" }}>
              <input type="hidden" name="organizationId" value={o.id} />
              <input className="lh-input" name="note" placeholder="Verification note" style={{ maxWidth: 240 }} />
              <button className="lh-btn lh-btn-sm" type="submit" name="decision" value="verify">Verify</button>
              <button className="lh-btn lh-btn-sm lh-btn-danger" type="submit" name="decision" value="reject">Reject</button>
            </form>
          </div>
        ))
      )}

      <h2>All users</h2>
      <table className="lh-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td><StatusBadge status={u.role} /></td>
              <td><StatusBadge status={u.status} /></td>
              <td className="lh-muted">{new Date(u.createdAt).toLocaleDateString("en-KE")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Shell>
  );
}
