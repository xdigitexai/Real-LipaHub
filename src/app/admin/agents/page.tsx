import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { isModelConfigured } from "@/modules/ai/adapter";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI agents — LipaHub AI" };

export default async function AdminAgentsPage() {
  await getAuthContext();
  const [runs, configs] = await Promise.all([
    prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 60 }),
    prisma.modelConfig.findMany({ orderBy: { purpose: "asc" } }),
  ]);
  const aiReady = isModelConfigured();

  const byAgent = new Map<string, { total: number; succeeded: number; unavailable: number; failed: number }>();
  for (const r of runs) {
    const agg = byAgent.get(r.agent) ?? { total: 0, succeeded: 0, unavailable: 0, failed: 0 };
    agg.total++;
    if (r.status === "SUCCEEDED") agg.succeeded++;
    if (r.status === "UNAVAILABLE") agg.unavailable++;
    if (r.status === "FAILED" || r.status === "TIMEOUT") agg.failed++;
    byAgent.set(r.agent, agg);
  }

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
      <h1>AI agent operations</h1>
      <div className={`lh-alert ${aiReady ? "lh-alert-info" : "lh-alert-warn"}`}>
        {aiReady ? (
          <><strong>Model configured.</strong> The adapter resolves purpose → provider/model from the table below (DB overrides env). No key is stored here or exposed to clients.</>
        ) : (
          <><strong>No model key configured.</strong> Agents record UNAVAILABLE runs and workflows fall back to deterministic paths + human review. Nothing is simulated.</>
        )}
      </div>

      <h2>Model configuration (purpose → model)</h2>
      <table className="lh-table">
        <thead><tr><th>Purpose</th><th>Provider</th><th>Model</th><th>Temperature</th><th>Max tokens</th><th>Enabled</th></tr></thead>
        <tbody>
          {configs.map((c) => (
            <tr key={c.id}>
              <td><code>{c.purpose}</code></td>
              <td>{c.provider}</td>
              <td>{c.model}</td>
              <td>{c.temperature}</td>
              <td>{c.maxTokens}</td>
              <td><StatusBadge status={c.enabled ? "ACTIVE" : "CANCELLED"} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Run statistics (last 60)</h2>
      <table className="lh-table">
        <thead><tr><th>Agent</th><th>Total</th><th>Succeeded</th><th>Unavailable</th><th>Failed/Timeout</th></tr></thead>
        <tbody>
          {[...byAgent.entries()].map(([agent, s]) => (
            <tr key={agent}>
              <td>{agent}</td>
              <td>{s.total}</td>
              <td>{s.succeeded}</td>
              <td>{s.unavailable}</td>
              <td>{s.failed}</td>
            </tr>
          ))}
          {byAgent.size === 0 && <tr><td colSpan={5} className="lh-muted">No runs yet.</td></tr>}
        </tbody>
      </table>

      <h2>Recent runs</h2>
      <table className="lh-table">
        <thead><tr><th>Agent</th><th>Status</th><th>Entity</th><th>Model</th><th>Tokens in/out</th><th>Latency</th><th>When</th></tr></thead>
        <tbody>
          {runs.slice(0, 25).map((r) => (
            <tr key={r.id}>
              <td>{r.agent}</td>
              <td><StatusBadge status={r.status} /></td>
              <td className="lh-muted">{r.entityType ?? "—"}{(r.entityId ?? "").slice(0, 8)}</td>
              <td className="lh-muted">{r.model ?? "—"}</td>
              <td className="lh-mono">{r.tokensIn}/{r.tokensOut}</td>
              <td className="lh-mono">{r.latencyMs ? `${r.latencyMs}ms` : "—"}</td>
              <td className="lh-muted">{new Date(r.createdAt).toLocaleString("en-KE")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Shell>
  );
}
