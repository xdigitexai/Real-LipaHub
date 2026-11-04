"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginAction, type ActionState } from "@/app/actions/auth";

export default function LoginPage() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(loginAction, null);

  useEffect(() => {
    if (state?.success === "ok") router.push("/dashboard");
  }, [state, router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "1.5rem" }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div className="lh-landing-nav" style={{ paddingTop: 0 }}>
          <Link href="/" className="lh-brand"><span className="lh-brand-dot" /> LipaHub AI</Link>
        </div>
        <div className="lh-card">
          <h1 style={{ marginBottom: "0.2rem" }}>Sign in</h1>
          <p className="lh-muted">Welcome back. Sign in to continue.</p>
          {state?.error && <div className="lh-alert lh-alert-error" role="alert">{state.error}</div>}
          <form action={formAction} className="lh-form" style={{ marginTop: "0.8rem" }}>
            <div className="lh-field">
              <label className="lh-label" htmlFor="email">Email</label>
              <input className="lh-input" id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="lh-field">
              <label className="lh-label" htmlFor="password">Password</label>
              <input className="lh-input" id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
            <button className="lh-btn" type="submit" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="lh-muted" style={{ marginTop: "0.8rem" }}>
            No account? <Link href="/register">Create one</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
