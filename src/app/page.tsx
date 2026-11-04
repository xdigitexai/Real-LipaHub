import Link from "next/link";
import { getAuthContext } from "@/lib/session-server";

export default async function LandingPage() {
  const ctx = await getAuthContext();
  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "1rem 1.5rem 3rem" }}>
      <nav className="lh-landing-nav">
        <span className="lh-brand"><span className="lh-brand-dot" /> LipaHub AI</span>
        <span className="lh-row">
          {ctx ? (
            <Link className="lh-btn lh-btn-sm" href="/dashboard">Go to dashboard</Link>
          ) : (
            <>
              <Link className="lh-btn lh-btn-secondary lh-btn-sm" href="/login">Sign in</Link>
              <Link className="lh-btn lh-btn-sm" href="/register">Get started</Link>
            </>
          )}
        </span>
      </nav>

      <section className="lh-hero">
        <h1>Legitimate online work, intelligently evaluated.</h1>
        <p>
          LipaHub AI connects workers with online earning opportunities and businesses with
          affordable digital work. Every opportunity discovered by our AI engine is screened for
          scams, reviewed by human moderators, and published with an explainable risk score — so
          you can decide with full information.
        </p>
        <div className="lh-row" style={{ marginTop: "1.2rem" }}>
          <Link className="lh-btn" href="/register?role=worker">Join as a worker</Link>
          <Link className="lh-btn lh-btn-secondary" href="/register?role=business">List work as a business</Link>
        </div>
        <p className="lh-disclaimer" style={{ color: "rgba(255,255,255,0.6)", marginTop: "1rem" }}>
          LipaHub never promises guaranteed income. Earnings depend on the opportunities you
          complete and the businesses that approve them.
        </p>
      </section>

      <div className="lh-grid lh-grid-3">
        <div className="lh-card">
          <h3>AI-screened opportunities</h3>
          <p className="lh-muted">
            Our Trust &amp; Safety engine flags upfront-fee scams, guaranteed-income claims and
            unrealistic pay before anything reaches the catalogue. Risk scores are explainable.
          </p>
        </div>
        <div className="lh-card">
          <h3>Funded tasks only</h3>
          <p className="lh-muted">
            Businesses must fund a campaign before any task can be published. Your reward is held
            in escrow the moment you are assigned — accounting is deterministic, not a promise.
          </p>
        </div>
        <div className="lh-card">
          <h3>Verified payouts</h3>
          <p className="lh-muted">
            Work is verified against the task requirements, every payment is journaled, and
            withdrawals are reviewed by a human before execution via M-Pesa.
          </p>
        </div>
      </div>

      <div className="lh-card">
        <h2>How it works</h2>
        <ol style={{ lineHeight: 1.9 }}>
          <li><strong>Businesses</strong> register, get verified, create campaigns and fund them (sandbox M-Pesa during rollout).</li>
          <li><strong>Tasks</strong> are published only after funding — rewards are reserved in escrow automatically.</li>
          <li><strong>Workers</strong> apply, receive instructions, and submit evidence of completed work.</li>
          <li><strong>The verification engine</strong> checks completeness and duplicates; uncertain cases go to human review.</li>
          <li><strong>Approved work</strong> releases the escrow to the worker&apos;s reward ledger minus the platform commission.</li>
        </ol>
      </div>

      <footer className="lh-disclaimer">
        © 2026 LipaHub AI · Opportunities are attributed to their original sources · M-Pesa runs in sandbox mode until compliance verification is complete.
      </footer>
    </main>
  );
}
