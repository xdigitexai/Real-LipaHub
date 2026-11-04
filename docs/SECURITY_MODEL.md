# LipaHub AI — Security Model

> Status: v0.1

## 1. Authentication

- Passwords: **Argon2id** (`@node-rs/argon2`, memory 19456 KiB,
  timeCost 2, parallelism 1 — OWASP baseline), never logged.
- Sessions: 256-bit opaque tokens; **only the SHA-256 hash** is stored
  (`Session.tokenHash`). Cookie `lipahub_session`, httpOnly, sameSite
  lax, secure in production, 7-day sliding expiry, revocable by
  deletion (admin logout-all supported).
- Role enum on the user row; every server action resolves
  `AuthContext = { user, role, organizationId?, workerProfileId? }`
  from the session before any service call.

## 2. Authorization (RBAC + ownership)

Two layers, always both:

1. **Route/action guard** (`requireRole`, `requireAuth`) at API route
   handlers and server actions.
2. **Service-level scoping**: every marketplace query filters by
   `organizationId` (business) or `workerId` (worker). Admin bypass is
   explicit (`role === ADMIN`).

Negative cases are tested: business A cannot read business B's
campaigns/submissions; worker A cannot read worker B's submissions or
ledger; suspended users are rejected at session resolution.

## 3. Input validation & injection

- All request bodies validated with **zod** schemas at the boundary.
- Prisma parameterizes all SQL — no string-built queries.
- Output escaping is React's default; no `dangerouslySetInnerHTML` in
  v0.1.
- File uploads (evidence): type+size allowlist, stored under
  `storage/evidence` with random names; served via authenticated route.

## 4. Rate limiting & abuse

- Redis token bucket keyed by IP+route for: login (5/min), register
  (3/hour), AI endpoints (20/min), submissions (10/hour), discovery
  trigger (admin only).
- Login failures are rate-limited and audited; no user enumeration
  (uniform error copy).

## 5. Financial controls

- Secrets only in env / DB `ModelConfig` (AI keys) — never in client
  bundles; API keys never sent to the browser.
- Money endpoints require an `Idempotency-Key` header or derived key;
  replays return the original result (unique constraint).
- Ledger is append-only; no endpoint mutates balances directly.
- Withdrawals: worker requests → admin approval → sandbox provider
  execution; each transition journaled + audited.
- AI output can **never** touch ledger/payment state — the orchestrator
  simply has no such capability; it writes structured verdicts only.

## 6. AI safety

- Structured outputs validated with zod; invalid JSON → retry → mark
  run FAILED, never silently accepted.
- Trust & Safety hard rules (upfront payment demands, guaranteed
  income claims, crypto-only payouts, age-inappropriate work) are
  deterministic code, not model judgement — the model supplements,
  never overrides.
- Uncertain verification (`confidence < threshold`) escalates to human
  review; thresholds configurable in admin.

## 7. Data protection

- Evidence files outside webroot; authenticated download route with
  ownership checks.
- Audit log records actor, IP, action, entity — retained
  indefinitely (append-only).
- `.env` git-ignored; `docs` and code contain no credentials.

## 8. Transport & headers

CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` locked, `poweredByHeader` disabled (mirrors the
hardened next.config pattern already proven on this machine).

## 9. Threat notes (v0.1 accepted risks)

- Single-server deployment; no WAF yet.
- Evidence files stored on local disk, not object storage.
- Email verification / 2FA not yet implemented — queued for Phase 10
  (documented, not silently missing).
