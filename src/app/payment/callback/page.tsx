import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment status — LipaHub AI" };

/**
 * Browser callback landing page. The provider's callback_url format is not
 * documented, so this page intentionally displays NO payment state and
 * NEVER credits anything — status is verified server-side via webhooks and
 * reconciliation. Users return to their dashboard to see the wallet.
 */
export default async function PaymentCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const reference = typeof params.reference === "string" ? params.reference : null;

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "1.5rem" }}>
      <div className="lh-card" style={{ maxWidth: 520, width: "100%" }}>
        <h1>Payment received — verifying</h1>
        <p>
          Thank you. Your payment is being verified against the payment provider before it is
          credited to your organization wallet. This usually takes a few seconds; mobile-money
          payments confirm once your phone transaction completes.
        </p>
        {reference && <p className="lh-muted">Provider reference: <code>{reference}</code></p>}
        <div className="lh-alert lh-alert-info">
          Verification is server-side: a browser redirect never credits an account.
        </div>
        <Link className="lh-btn" href="/business">Back to business dashboard</Link>
      </div>
    </main>
  );
}
