"use client";

import { useActionState } from "react";
import { createSourceAction } from "@/app/actions/platform";
import { SubmitButton, FormMessage } from "@/components/forms";
import type { ActionState } from "@/app/actions/auth";

export function CreateSourceForm() {
  const [state, action] = useActionState<ActionState | null, FormData>(createSourceAction, null);
  return (
    <form action={action} className="lh-form lh-form-wide">
      <div className="lh-field">
        <label className="lh-label" htmlFor="name">Source name</label>
        <input className="lh-input" id="name" name="name" required minLength={3} maxLength={120} placeholder="Remote job boards aggregator" />
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="kind">Source kind</label>
        <select className="lh-select" id="kind" name="kind" defaultValue="RSS">
          <option value="RSS">RSS/Atom feed</option>
          <option value="HTML">HTML page</option>
          <option value="API">API (requires config)</option>
          <option value="MANUAL">Manual entry</option>
        </select>
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="url">URL (required unless manual)</label>
        <input className="lh-input" id="url" name="url" type="url" placeholder="https://example.com/feed.xml" />
      </div>
      <div className="lh-field">
        <label className="lh-label" htmlFor="trustLevel">Trust level</label>
        <select className="lh-select" id="trustLevel" name="trustLevel" defaultValue="NEUTRAL">
          <option value="TRUSTED">Trusted</option>
          <option value="NEUTRAL">Neutral</option>
          <option value="UNTRUSTED">Untrusted</option>
        </select>
        <span className="lh-muted">Only add sources you are permitted to use. The fetcher sends a descriptive User-Agent and is rate-limited.</span>
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Creating…">Create source</SubmitButton>
    </form>
  );
}
