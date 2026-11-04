"use client";

import { useActionState } from "react";
import { applyToTaskAction, submitWorkAction, requestWithdrawalAction } from "@/app/actions/platform";
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
  const [state, action] = useActionState<ActionState | null, FormData>(requestWithdrawalAction, null);
  return (
    <form action={action} className="lh-form">
      <div className="lh-field">
        <label className="lh-label" htmlFor="amount">Amount (KES)</label>
        <input className="lh-input" id="amount" name="amount" type="number" step="0.01" min="1" max={(maxAmount / 100).toFixed(2)} required />
        <span className="lh-muted">Available: {(maxAmount / 100).toFixed(2)} KES</span>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="destination">M-Pesa number</label>
        <input className="lh-input" id="destination" name="destination" placeholder="2547XXXXXXXX" required />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Requesting…">Request withdrawal</SubmitButton>
    </form>
  );
}
