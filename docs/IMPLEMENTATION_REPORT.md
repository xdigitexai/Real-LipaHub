# LipaHub AI — Milestone 0 Implementation Report

> Date: 2026-11-04 · Status: Foundation + first vertical slice **implemented, tested and browser-verified**
> Commits: `66c776c` (foundation) · `ebe387b` (E2E fixes)

## 1. Environment decision (honest audit)

| Requirement | This machine | Decision |
|---|---|---|
| PostgreSQL | None installed; Docker Desktop present but its Linux engine cannot start (no WSL2 backend) | **Embedded PostgreSQL 17.4** binaries (npm `@embedded-postgres/windows-x64`) driven via initdb/pg_ctl; one package bug fixed (missing `share/timezonesets/Default`, restored from official PG source). Data dir outside repo. Dev mode runs `fsync=off` — documented, dev only. |
| Redis | Not installed | **PostgreSQL-backed queue driver** (`FOR UPDATE SKIP LOCKED`, retries/backoff, dead letters, recurring sweep). BullMQ path auto-activates when Redis is reachable (`detectDriver()` logs the choice). |
| AI (GLM-5.3-Flash) | No API key on machine | Adapter implemented against Z.ai OpenAI-compatible endpoint, key from env only. Without a key, agents record honest `UNAVAILABLE` runs; deterministic hard rules still run; moderation/verification escalate to humans. **Nothing fabricated.** |

## 2. What exists now (files)

**Docs** — `docs/ARCHITECTURE.md`, `PRODUCT_SPEC.md`, `DATABASE_DESIGN.md`, `SECURITY_MODEL.md`, `IMPLEMENTATION_ROADMAP.md`.

**Core libs** — `src/lib/`: env (single source of config), db (Prisma 7 + pg adapter), crypto (Argon2id, session tokens, sha256), money (integer minor units, commission bps), errors (typed AppError), logger (JSON lines), rate-limit (Redis token bucket, fails open), session-server (only framework touchpoint).

**Modules** — `src/modules/`:
- `identity/` — register/login/sessions/RBAC guards, org verification states
- `finance/` — double-entry ledger (`ledger.ts`: balanced journals, idempotency, account balances), service (funding, escrow reservations, commission payouts, withdrawals), provider (M-Pesa sandbox adapter, swappable)
- `marketplace/` — campaigns→tasks (publish reserves escrow)→applications→assignments→submissions→reviews; tenant-scoped reads
- `verification/` — deterministic checks (completeness, links, cross-worker duplicate hashing) + AI layer + human escalation, confidence thresholds
- `opportunities/` — sources, RSS/HTML parsing, dedupe (urlHash unique + titleFuzzyHash), hard risk rules (upfront-fee/guaranteed-income/crypto-only/recruitment/unrealistic-pay/off-platform regexes), moderation gate, catalogue
- `ai/` — ModelAdapter (purpose→provider/model via DB `ModelConfig`, env fallback), orchestrator (zod-validated structured output, bounded retries, token accounting, AgentRun/AgentEvent persistence), agents (research, trust-safety with safety-floor merge, evidence-verification, matching)
- `notifications/`, `audit/` — persistent records used across flows

**Jobs** — `src/jobs/`: driver detection, BullMQ queues, `pg-queue.ts` (Postgres driver), worker process (`npm run worker`) with Operations sweep (stale agent runs → TIMEOUT, failing sources → admin notifications).

**UI** — Next.js 16 App Router: landing (income-disclaimer), auth (role deep-link), worker (overview/discover/assignments/rewards+withdrawals), business (campaigns/funding/tasks/applications/reviews/analytics), admin (overview/sources/moderation/catalogue/users/withdrawals/ledger/agents/verifications/audit), `/api/health`. Server actions for all mutations; hardened headers.

**DB** — `prisma/schema.prisma` (~30 models), migration `20261104192432_init` applied. `scripts/seed.ts` (admin `admin@lipahub.local` / `LipaHubAdmin!2026`, ModelConfig rows, chart of accounts).

**Tests** — `tests/finance.test.ts`, `tests/opportunities.test.ts`, `tests/identity.test.ts`.

## 3. Database changes
Initial migration only. Money is BigInt minor units. Invariants enforced: journals balance; per-(source,urlHash) uniqueness; one application/assignment per (task, worker); idempotency keys on funding/withdrawals/journals; escrow release only from HELD reservations.

## 4. Tests executed
- `npx vitest run` → **30/30 passed** (ledger invariants incl. full-history sweep, idempotent funding, over-reservation rejection, cross-org funding rejection, full slice payout math with 10% commission, duplicate-evidence FAIL, withdrawal balance guard + admin payout, moderation gate, hard risk rules, AI-unavailable honesty, fuzzy dedupe, RSS parsing, JSON extraction, RBAC, tenant isolation, suspended sessions, multi-slot discovery regression)
- `npx tsc --noEmit` → clean
- `/api/health` → `{"status":"healthy","database":"up","queue":{"driver":"postgres"}}`

## 5. Browser-verified end-to-end (real UI + real DB)
1. Business registered (`/register?role=business`) → org PENDING; create-campaign correctly gated.
2. Admin verified the org (audit + note recorded).
3. Business created campaign, funded **5,000 KES** (sandbox M-Pesa) → `CAMPAIGN_FUNDING` journal, campaign FUNDED.
4. Task published (250 KES × 2 slots) → `TASK_RESERVATION` journal, escrow 500.00 held.
5. Worker registered, applied; business accepted → assignment ACTIVE + notification.
6. Worker submitted evidence → deterministic verification → **UNCERTAIN (40%), escalated** (AI unavailable — honest) → NEEDS_REVIEW.
7. Business approved → `REWARD_PAYOUT`: Dr task-escrow 250.00 / Cr worker-payable 225.00 / Cr platform-revenue 25.00; worker ledger + notification.
8. Worker requested 200.00 withdrawal → admin approved → **PAID** (sandbox ref `SBX-P-f72433bd1c`), worker balance 25.00 KES.
9. Opportunity intelligence: admin source created → **scam listing ingested → CRITICAL** with upfront-payment/guaranteed-income/off-platform/crypto signals → moderator rejected; **legitimate listing approved → published** to worker catalogue; 36 `UNAVAILABLE` agent runs recorded.
10. Negative case: business opening a worker's assignment URL → 404.

## 6. Defects found & fixed during E2E
- Multi-slot task disappeared from discovery after first acceptance (status IN_PROGRESS excluded by `listOpenTasks`) → fixed, regression test added.
- Programmatic radio selection didn't drive React state in the embedded browser → `?role=` deep-link (also improves landing CTAs).
- ioredis error-event spam when Redis absent → error handler + no-retry strategy.
- Prisma 7 requires `prisma.config.ts` for migrate (datasource URL) — configured.
- (Environment) `@embedded-postgres` missing `timezonesets/Default` → restored from PG source.

## 7. Security posture
Argon2id passwords; opaque hashed session tokens (revocable); RBAC at route+service; zod-validated inputs; money endpoints idempotent; ledger append-only; AI has no financial capability; no secrets in client bundles; `.env` git-ignored. Known gaps (queued): email verification, 2FA, evidence file uploads (text/link only in v0.1), live M-Pesa (sandbox only), email/push delivery.

## 8. Next milestone (M1)
Real RSS/HTML source hardening (robots.txt, per-source rate limits, health metrics), M-Pesa Daraja sandbox STK-push + callback verification, dispute workflow UI, email notifications.
