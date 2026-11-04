"use client";

import { useActionState } from "react";
import {
  createCampaignAction, fundCampaignAction, createTaskAction, reviewSubmissionAction,
} from "@/app/actions/platform";
import { SubmitButton, FormMessage } from "@/components/forms";
import type { ActionState } from "@/app/actions/auth";

export function CreateCampaignForm() {
  const [state, action] = useActionState<ActionState | null, FormData>(createCampaignAction, null);
  return (
    <form action={action} className="lh-form lh-form-wide">
      <div className="lh-field">
        <label className="lh-label" htmlFor="title">Campaign title</label>
        <input className="lh-input" id="title" name="title" required minLength={4} maxLength={160} placeholder="Q4 product review collection" />
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="description">Description</label>
        <textarea className="lh-textarea" id="description" name="description" required minLength={10} placeholder="What is this campaign about? What kind of work will be published?" />
      </div>
      <div className="lh-row">
        <div className="lh-field" style={{ flex: 1 }}>
          <label className="lh-label" htmlFor="category">Category</label>
          <select className="lh-select" id="category" name="category" defaultValue="content">
            <option value="content">Content</option>
            <option value="data-entry">Data entry</option>
            <option value="microtask">Microtask</option>
            <option value="testing">Testing</option>
            <option value="transcription">Transcription</option>
            <option value="design">Design</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="lh-field" style={{ flex: 1 }}>
          <label className="lh-label" htmlFor="budget">Budget (KES)</label>
          <input className="lh-input" id="budget" name="budget" type="number" step="0.01" min="1" required />
        </div>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Creating…">Create campaign</SubmitButton>
    </form>
  );
}

export function FundCampaignForm({ campaignId }: { campaignId: string }) {
  const [state, action] = useActionState<ActionState | null, FormData>(fundCampaignAction, null);
  return (
    <form action={action} className="lh-form">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="lh-field">
        <label className="lh-label" htmlFor="amount">Amount to fund (KES)</label>
        <input className="lh-input" id="amount" name="amount" type="number" step="0.01" min="1" required />
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="payer">M-Pesa payer number (sandbox)</label>
        <input className="lh-input" id="payer" name="payer" defaultValue="254700000000" required />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Processing sandbox payment…">Fund via M-Pesa (sandbox)</SubmitButton>
    </form>
  );
}

export function CreateTaskForm({ campaignId }: { campaignId: string }) {
  const [state, action] = useActionState<ActionState | null, FormData>(createTaskAction, null);
  return (
    <form action={action} className="lh-form lh-form-wide">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="lh-field">
        <label className="lh-label" htmlFor="title">Task title</label>
        <input className="lh-input" id="title" name="title" required minLength={4} maxLength={200} placeholder="Summarize a product page in 3 bullets" />
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="instructions">Instructions for workers</label>
        <textarea className="lh-textarea" id="instructions" name="instructions" required minLength={10} placeholder="Step-by-step what the worker should do…" />
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="deliverableSpec">Deliverable specification</label>
        <input className="lh-input" id="deliverableSpec" name="deliverableSpec" required minLength={5} placeholder="A link to a document containing…" />
      </div>
      <div className="lh-row">
        <div className="lh-field" style={{ flex: 1 }}>
          <label className="lh-label" htmlFor="category">Category</label>
          <select className="lh-select" id="category" name="category" defaultValue="microtask">
            <option value="content">Content</option>
            <option value="data-entry">Data entry</option>
            <option value="microtask">Microtask</option>
            <option value="testing">Testing</option>
            <option value="transcription">Transcription</option>
            <option value="design">Design</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="lh-field" style={{ flex: 1 }}>
          <label className="lh-label" htmlFor="reward">Reward per slot (KES)</label>
          <input className="lh-input" id="reward" name="reward" type="number" step="0.01" min="1" required />
        </div>
        <div className="lh-field" style={{ flex: 1 }}>
          <label className="lh-label" htmlFor="slots">Slots</label>
          <input className="lh-input" id="slots" name="slots" type="number" min="1" max="1000" defaultValue="1" required />
        </div>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="evidenceRequirements">Evidence requirements (one per line)</label>
        <textarea className="lh-textarea" id="evidenceRequirements" name="evidenceRequirements" placeholder={"A working link to the deliverable\nA screenshot of the completed work"} />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Creating…">Create task (draft)</SubmitButton>
    </form>
  );
}

export function ReviewSubmissionForm({ submissionId }: { submissionId: string }) {
  const [state, action] = useActionState<ActionState | null, FormData>(reviewSubmissionAction, null);
  return (
    <form action={action} className="lh-form" style={{ marginTop: "0.5rem" }}>
      <input type="hidden" name="submissionId" value={submissionId} />
      <div className="lh-row">
        <button className="lh-btn lh-btn-sm" type="submit" name="decision" value="approve">Approve &amp; pay</button>
        <button className="lh-btn lh-btn-sm lh-btn-danger" type="submit" name="decision" value="reject">Reject</button>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor={`reason-${submissionId}`}>Explanation (required for rejection)</label>
        <input className="lh-input" id={`reason-${submissionId}`} name="reason" maxLength={500} placeholder="Why this decision — shown to the worker" />
      </div>
      <FormMessage state={state} />
    </form>
  );
}
