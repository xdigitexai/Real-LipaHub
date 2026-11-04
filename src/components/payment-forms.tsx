"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { initiateDepositAction, fundFromWalletAction, pollPaymentStatus } from "@/app/actions/payments";
import { SubmitButton, FormMessage } from "@/components/forms";
import type { ActionState } from "@/app/actions/auth";

const GATEWAY_LABELS: Record<string, string> = {
  safaricom: "M-Pesa Kenya (STK push)",
  airtel: "Airtel Money Kenya (STK push)",
  mobile: "Pan-African mobile money",
  card: "Visa / Mastercard (hosted checkout)",
  crypto: "Cryptocurrency checkout",
};

const PHONE_GATEWAYS = new Set(["safaricom", "airtel", "mobile"]);

/**
 * Wallet deposit form. Handles all three documented response kinds:
 *  - STK push: shows "check your phone" + polls internal status
 *  - redirect (card): navigates to the provider's secure redirect_url
 *  - crypto: opens the checkout_url
 */
export function DepositForm({ gateways, recommended, currency }: { gateways: string[]; recommended: string; currency: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState | null, FormData>(initiateDepositAction, null);
  const [stk, setStk] = useState<{ internalRef: string; message: string } | null>(null);

  useEffect(() => {
    if (!state?.success) return;
    if (state.success.startsWith("STK_SENT:")) {
      const [, ref, message] = state.success.split(":");
      setStk({ internalRef: ref, message });
      return;
    }
    if (state.success.startsWith("REDIRECT:")) {
      const url = state.success.slice("REDIRECT:".length);
      window.location.href = url;
    }
  }, [state]);

  useEffect(() => {
    if (!stk) return;
    const timer = setInterval(async () => {
      const status = await pollPaymentStatus(stk.internalRef);
      if (status && (status.status === "COMPLETED" || status.status === "FAILED" || status.status === "UNCERTAIN")) {
        clearInterval(timer);
        setStk(null);
        router.refresh();
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [stk, router]);

  if (stk) {
    return (
      <div className="lh-alert lh-alert-info" role="status">
        <strong>{stk.message}</strong>
        <p style={{ margin: "0.4rem 0 0" }}>Waiting for the provider to confirm the payment… The wallet is credited only after server-side verification — this page updates automatically.</p>
      </div>
    );
  }

  return (
    <form action={action} className="lh-form">
      <div className="lh-field">
        <label className="lh-label" htmlFor="dep-amount">Amount ({currency})</label>
        <input className="lh-input" id="dep-amount" name="amount" type="number" step="0.01" min="1" required />
        <span className="lh-muted">The provider&apos;s processing fee is deducted before the wallet is credited; the exact fee is shown after initiation and recorded on the transaction.</span>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="dep-gateway">Payment method</label>
        <select className="lh-select" id="dep-gateway" name="gateway" defaultValue={recommended}>
          {gateways.map((g) => (
            <option key={g} value={g}>{GATEWAY_LABELS[g] ?? g}</option>
          ))}
        </select>
        <span className="lh-muted">Kenyan users: M-Pesa is recommended by default.</span>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="dep-phone">Phone (international format, e.g. +254712345678)</label>
        <input className="lh-input" id="dep-phone" name="phone" placeholder="+254712345678" />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Starting payment…">Start deposit</SubmitButton>
    </form>
  );
}

export function FundFromWalletForm({ campaignId, walletBalance, currency }: { campaignId: string; walletBalance: number; currency: string }) {
  const [state, action] = useActionState<ActionState | null, FormData>(fundFromWalletAction, null);
  return (
    <form action={action} className="lh-form">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="lh-field">
        <label className="lh-label" htmlFor="fw-amount">Amount ({currency})</label>
        <input className="lh-input" id="fw-amount" name="amount" type="number" step="0.01" min="1" max={walletBalance.toFixed(2)} required />
        <span className="lh-muted">Wallet available: {walletBalance.toFixed(2)} {currency}</span>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Funding…">Fund campaign from wallet</SubmitButton>
    </form>
  );
}
