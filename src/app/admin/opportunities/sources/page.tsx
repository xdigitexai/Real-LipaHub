import { Shell, StatusBadge } from "@/components/shell";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/session-server";
import { CreateSourceForm } from "@/components/admin-forms";
import { triggerDiscoveryAction } from "@/app/actions/platform";
import { isModelConfigured } from "@/modules/ai/adapter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Opportunity sources — LipaHub AI" };

export default async function SourcesPage() {
  const ctx = await getAuthContext();
  const sources = await prisma.opportunitySource.findMany({ orderBy: { createdAt: "desc" } });
  const aiReady = isModelConfigured();

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
      <h1>Opportunity sources</h1>
      {!aiReady && (
        <div className="lh-alert lh-alert-warn">
          <strong>AI layer not configured</strong> — no LIPAHUB_AI_API_KEY is set. Discovery still works:
          listings are stored raw, hard-rule risk scoring runs deterministically, and rows are flagged for
          moderation with reduced confidence. Nothing is fabricated.
        </div>
      )}
      <p className="lh-muted">
        Approved sources feed the discovery pipeline: fetch → AI research extraction → duplicate
        detection → trust &amp; safety scoring → moderation gate → publish to catalogue.
      </p>

      <div className="lh-card">
        <h3 style={{ marginTop: 0 }}>Add a source</h3>
        <CreateSourceForm />
      </div>

      <h2>Registered sources</h2>
      {sources.length === 0 ? (
        <div className="lh-card lh-muted">No sources yet.</div>
      ) : (
        sources.map((s) => (
          <div key={s.id} className="lh-card">
            <div className="lh-row">
              <h3 style={{ margin: 0 }}>{s.name}</h3>
              <StatusBadge status={s.trustLevel} />
              <StatusBadge status={s.enabled ? "ACTIVE" : "CANCELLED"} />
              <span className="lh-spacer" />
              <span className="lh-muted">{s.kind}</span>
            </div>
            <p className="lh-muted">
              {s.url ?? "manual entries"} · interval {s.fetchIntervalMinutes}m ·
              last fetch: {s.lastFetchedAt ? `${new Date(s.lastFetchedAt).toLocaleString("en-KE")} (${s.lastFetchStatus ?? "?"})` : "never"}
              {s.consecutiveFailures > 0 ? ` · ⚠ ${s.consecutiveFailures} consecutive failures` : ""}
            </p>
            <details>
              <summary>Trigger discovery</summary>
              {s.kind === "MANUAL" ? (
                <form action={triggerDiscoveryAction} className="lh-form lh-form-wide" style={{ marginTop: "0.5rem" }}>
                  <input type="hidden" name="sourceId" value={s.id} />
                  <input type="hidden" name="kind" value="MANUAL" />
                  <p className="lh-muted">Paste a publicly available listing verbatim. Attribution is recorded; the AI engine extracts and evaluates it.</p>
                  <div className="lh-field">
                    <label className="lh-label" htmlFor={`lt-${s.id}`}>Listing title</label>
                    <input className="lh-input" id={`lt-${s.id}`} name="listingTitle" required />
                  </div>
                  <div className="lh-field">
                    <label className="lh-label" htmlFor={`lb-${s.id}`}>Listing body</label>
                    <textarea className="lh-textarea" id={`lb-${s.id}`} name="listingBody" required />
                  </div>
                  <div className="lh-field">
                    <label className="lh-label" htmlFor={`lu-${s.id}`}>Source URL (optional)</label>
                    <input className="lh-input" id={`lu-${s.id}`} name="listingUrl" type="url" />
                  </div>
                  <button className="lh-btn" type="submit">Ingest listing</button>
                </form>
              ) : (
                <form action={triggerDiscoveryAction} style={{ marginTop: "0.5rem" }}>
                  <input type="hidden" name="sourceId" value={s.id} />
                  <input type="hidden" name="kind" value={s.kind} />
                  <button className="lh-btn lh-btn-sm" type="submit">Fetch now</button>
                </form>
              )}
            </details>
          </div>
        ))
      )}
    </Shell>
  );
}
