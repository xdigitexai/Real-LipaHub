"use client";

import { useActionState, useState } from "react";
import { applyToTaskAction, submitWorkAction } from "@/app/actions/platform";
import { requestWithdrawalWithFeeAction } from "@/app/actions/payments";
import { SubmitButton, FormMessage } from "@/components/forms";
import type { ActionState } from "@/app/actions/auth";

export function ApplyForm({ taskId }: { taskId: string }) {
  const [state, action] = useActionState<ActionState | null, FormData>(applyToTaskAction, null);
  return (
    <form action={action} className="lh-form" style={{ maxWidth: 520 }}>
      <input type="hidden" name="taskId" value={taskId} />
      <div className="lh-field">
        <label className="lh-label" htmlFor={`msg-${taskId}`}>Message (optional)</label>
        <textarea className="lh-textarea" id={`msg-${taskId}`} name="message" placeholder="Briefly say why you are a good fit…" maxLength={2000} />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Applying…">Apply for this task</SubmitButton>
    </form>
  );
}

export function SubmitWorkForm({ assignmentId, evidenceRequirements }: { assignmentId: string; evidenceRequirements: string[] }) {
  const [state, action] = useActionState<ActionState | null, FormData>(submitWorkAction, null);
  return (
    <form action={action} className="lh-form lh-form-wide">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <div className="lh-field">
        <label className="lh-label" htmlFor="evidence">Evidence — one item per line</label>
        <textarea
          className="lh-textarea"
          id="evidence"
          name="evidence"
          required
          placeholder={"https://docs.example.com/my-deliverable\nNotes about how the work was completed"}
        />
        <span className="lh-muted">
          Links are validated. {evidenceRequirements.length > 0 ? `Task expects: ${evidenceRequirements.join("; ")}.` : null}
        </span>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="notes">Notes (optional)</label>
        <textarea className="lh-textarea" id="notes" name="notes" maxLength={4000} />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Submitting…">Submit work</SubmitButton>
    </form>
  );
}

export function WithdrawalForm({ maxAmount }: { maxAmount: number }) {
  const [state, action] = useActionState<ActionState | null, FormData>(requestWithdrawalWithFeeAction, null);
  const [amount, setAmount] = useState("");
  const fee = Number.isFinite(Number(amount)) && Number(amount) > 0 ? (Number(amount) * 0.03).toFixed(2) : "0.00";
  const net = Number.isFinite(Number(amount)) && Number(amount) > 0 ? (Number(amount) * 0.97).toFixed(2) : "0.00";
  return (
    <form action={action} className="lh-form">
      <div className="lh-field">
        <label className="lh-label" htmlFor="amount">Amount (KES)</label>
        <input className="lh-input" id="amount" name="amount" type="number" step="0.01" min="10" max={(maxAmount / 100).toFixed(2)} required
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <span className="lh-muted">Available: {(maxAmount / 100).toFixed(2)} KES · Minimum 10.00 KES</span>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="destination">M-Pesa number (international format)</label>
        <input className="lh-input" id="destination" name="destination" placeholder="+254712345678" required />
      </div>
      <div className="lh-alert lh-alert-info" style={{ margin: 0 }}>
        Provider withdrawal fee (3%): <strong>{fee} KES</strong> · Net payout to your phone: <strong>{net} KES</strong>
        <div className="lh-muted">Paid via mobile_money through the payment provider after administrator approval.</div>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Requesting…">Request withdrawal</SubmitButton>
    </form>
  );
}
