"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({ children, className, pendingLabel }: {
  children: React.ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className ?? "lh-btn"}>
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}

export function FormMessage({ state }: { state: { error?: string; success?: string } | null }) {
  if (!state) return null;
  if (state.error) return <div className="lh-alert lh-alert-error" role="alert">{state.error}</div>;
  if (state.success && state.success !== "ok") return <div className="lh-alert lh-alert-info" role="status">{state.success}</div>;
  return null;
}
