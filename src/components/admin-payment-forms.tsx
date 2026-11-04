"use client";

import { useActionState } from "react";
import {
  retryReconciliationAction, testProviderConnectionAction, savePaymentSettingsAction,
} from "@/app/actions/payments";
import { SubmitButton, FormMessage } from "@/components/forms";
import type { ActionState } from "@/app/actions/auth";

export function RetryReconciliationForm() {
  const [state, action] = useActionState<ActionState | null, FormData>(retryReconciliationAction, null);
  return (
    <form action={action}>
      <p className="lh-muted">
        Safe operation: this only re-queries the provider&apos;s authoritative status endpoints for
        pending transactions. Nothing is ever forced to &quot;completed&quot; and no payment is resubmitted.
      </p>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Sweeping…">Run reconciliation sweep</SubmitButton>
    </form>
  );
}

export function TestConnectionForm() {
  const [state, action] = useActionState<ActionState | null, FormData>(testProviderConnectionAction, null);
  return (
    <form action={action}>
      <p className="lh-muted">
        Calls <code>GET /balance</code> server-side. The saved API key is never displayed, logged,
        or sent to the browser.
      </p>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Testing…">Test provider connection</SubmitButton>
    </form>
  );
}

export function PaymentSettingsForm({ gateways, recommended, minUnits, maxUnits }: {
  gateways: string[];
  recommended: string;
  minUnits: number;
  maxUnits: number;
}) {
  const [state, action] = useActionState<ActionState | null, FormData>(savePaymentSettingsAction, null);
  const all = ["safaricom", "airtel", "card", "mobile", "crypto"];
  const labels: Record<string, string> = {
    safaricom: "M-Pesa Kenya (STK)", airtel: "Airtel Money Kenya", mobile: "Pan-African mobile money",
    card: "Card (hosted checkout)", crypto: "Cryptocurrency",
  };
  return (
    <form action={action} className="lh-form lh-form-wide">
      <div className="lh-row">
        {all.map((g) => (
          <label key={g} className="lh-row" style={{ gap: "0.3rem" }}>
            <input type="checkbox" name={`gateway_${g}`} defaultChecked={gateways.includes(g)} />
            <span>{labels[g]}</span>
          </label>
        ))}
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="recommendedGateway">Recommended method (Kenyan users default)</label>
        <select className="lh-select" id="recommendedGateway" name="recommendedGateway" defaultValue={recommended}>
          {all.map((g) => <option key={g} value={g}>{labels[g]}</option>)}
        </select>
      </div>
      <div className="lh-row">
        <div className="lh-field" style={{ flex: 1 }}>
          <label className="lh-label" htmlFor="minWithdrawal">Minimum withdrawal (KES)</label>
          <input className="lh-input" id="minWithdrawal" name="minWithdrawal" type="number" step="0.01" min="1" defaultValue={minUnits} />
        </div>
        <div className="lh-field" style={{ flex: 1 }}>
          <label className="lh-label" htmlFor="maxWithdrawal">Maximum withdrawal (KES)</label>
          <input className="lh-input" id="maxWithdrawal" name="maxWithdrawal" type="number" step="0.01" min="1" defaultValue={maxUnits} />
        </div>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
    </form>
  );
}
