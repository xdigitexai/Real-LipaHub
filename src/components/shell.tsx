import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/session-server";
import { logoutAction } from "@/app/actions/auth";

export interface NavItem { href: string; label: string }

export async function Shell({ nav, children }: { nav: NavItem[]; children: React.ReactNode }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  return (
    <div className="lh-shell">
      <aside className="lh-sidebar">
        <Link href="/" className="lh-brand"><span className="lh-brand-dot" /> LipaHub AI</Link>
        <nav className="lh-nav">
          {nav.map((item) => (
            <Link key={item.href} href={item.href}>{item.label}</Link>
          ))}
        </nav>
        <div className="lh-sidebar-footer">
          <div>{ctx.name}</div>
          <div>{ctx.email}</div>
          <form action={logoutAction}>
            <button className="lh-btn lh-btn-sm lh-btn-secondary" type="submit" style={{ marginTop: "0.5rem" }}>Sign out</button>
          </form>
        </div>
      </aside>
      <main className="lh-main">{children}</main>
    </div>
  );
}

export function Badge({ tone, children }: { tone: "green" | "amber" | "red" | "slate"; children: React.ReactNode }) {
  return <span className={`lh-badge lh-badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = (["ACTIVE", "OPEN", "APPROVED", "FUNDED", "PUBLISHED", "VERIFIED", "PAID", "SUCCEEDED", "CONFIRMED", "AUTO_VERIFIED"].includes(status)
    ? "green"
    : ["PENDING", "PENDING_REVIEW", "SUBMITTED", "IN_REVIEW", "NEEDS_REVIEW", "EVALUATED", "AUTO", "PROCESSING", "DISCOVERED"].includes(status)
      ? "amber"
      : ["REJECTED", "FAILED", "CRITICAL", "HIGH", "SUSPENDED", "CANCELLED"].includes(status)
        ? "red"
        : "slate") as "green" | "amber" | "red" | "slate";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}
