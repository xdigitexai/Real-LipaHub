"use client";

import { Suspense, useActionState, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { registerAction, type ActionState } from "@/app/actions/auth";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [role, setRole] = useState<"WORKER" | "BUSINESS">(
    searchParams.get("role") === "business" ? "BUSINESS" : "WORKER",
  );
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(registerAction, null);

  useEffect(() => {
    if (state?.success === "ok") router.push("/dashboard");
  }, [state, router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "1.5rem" }}>
      <div style={{ width: "100%", maxWidth: 480 }}>
        <div className="lh-landing-nav" style={{ paddingTop: 0 }}>
          <Link href="/" className="lh-brand"><span className="lh-brand-dot" /> LipaHub AI</Link>
        </div>
        <div className="lh-card">
          <h1 style={{ marginBottom: "0.2rem" }}>Create your account</h1>
          <p className="lh-muted">Join as a worker looking for legitimate earning opportunities, or as a business that needs digital work done.</p>
          {state?.error && <div className="lh-alert lh-alert-error" role="alert">{state.error}</div>}
          <form action={formAction} className="lh-form lh-form-wide" style={{ marginTop: "0.8rem" }}>
            <div className="lh-field">
              <span className="lh-label">I am a…</span>
              <div className="lh-row">
                <label><input type="radio" name="role" value="WORKER" checked={role === "WORKER"} onChange={() => setRole("WORKER")} /> Worker</label>
                <label><input type="radio" name="role" value="BUSINESS" checked={role === "BUSINESS"} onChange={() => setRole("BUSINESS")} /> Business</label>
              </div>
            </div>
            <div className="lh-field">
              <label className="lh-label" htmlFor="name">Full name</label>
              <input className="lh-input" id="name" name="name" required minLength={2} maxLength={120} />
            </div>
            {role === "BUSINESS" && (
              <div className="lh-field">
                <label className="lh-label" htmlFor="organizationName">Organization name</label>
                <input className="lh-input" id="organizationName" name="organizationName" required minLength={2} maxLength={160} />
              </div>
            )}
            <div className="lh-field">
              <label className="lh-label" htmlFor="email">Email</label>
              <input className="lh-input" id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="lh-field">
              <label className="lh-label" htmlFor="password">Password</label>
              <input className="lh-input" id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />
              <span className="lh-muted">At least 8 characters.</span>
            </div>
            <button className="lh-btn" type="submit" disabled={pending}>
              {pending ? "Creating account…" : "Create account"}
            </button>
          </form>
          <p className="lh-muted" style={{ marginTop: "0.8rem" }}>
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
