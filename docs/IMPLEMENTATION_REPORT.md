# LipaHub AI — Implementation Report

> Milestone 0: 2026-11-04 · Milestone 1 (Xdigitex Pay): 2026-11-05
> Status: foundation + payment-provider integration **implemented, tested and browser-verified**

---

# Milestone 1 — Xdigitex Pay integration (2026-11-05)

## 1. Documentation grounding (verified against the live docs)

Fetched https://pay.xdigitex.space/docs before writing code. Implemented exactly the published surface:

| Documented | Implemented |
|---|---|
| `POST /payments/initiate` (fields incl. `email`, `first_name`, `last_name`) | ✅ all fields sent; response parsed with zod (reference, fee, net_amount, redirect_url, deposit_id/pawa_status/correspondent, checkout_url/qrcode_link) |
| `GET /payments/{reference}/status` | ✅ authoritative verification source for every webhook + reconciliation |
| `GET /balance` | ✅ admin reconciliation + connection test |
| `POST /withdrawals` (`method: "mobile_money"`) | ✅ two-phase withdrawal submission |
| `GET /withdrawals` (paginated history) | ✅ withdrawal reconciliation (see gap #1) |
| Statuses `pending/processing/completed/failed` | ✅ mapped to internal states incl. `UNCERTAIN` |
| Gateways `safaricom/airtel/card/mobile/crypto` | ✅ selectable, admin-toggleable, M-Pesa recommended for KES |
| Deposit fee returned in response (docs example 12%) | ✅ stored per transaction; **wallet is credited NET** so internal `provider-clearing` mirrors the real provider wallet |

**Documented gaps and the safe fallbacks built for each (nothing guessed):**
1. **No webhook signature scheme published** → webhook payloads are NEVER trusted: every delivery is verified against `GET /payments/{reference}/status` (reference + amount + currency + status must all agree). Additionally, if `XDIGITEX_PAY_WEBHOOK_SECRET` is set, requests must carry a matching `X-Webhook-Secret` header (our convention, documented in the admin settings page). Rejections are audited.
2. **No single-withdrawal status endpoint** → withdrawal final status is resolved from the paginated `GET /withdrawals` history; references absent from history for 30+ minutes become **UNCERTAIN** for admin review and are **never resubmitted automatically** (double-payout protection).
3. **`callback_url` payload format unspecified** → the browser callback page (`/payment/callback`) displays no payment state and never credits anything.
4. **No error-code schema / no idempotency guidance** → non-2xx or unparseable responses are treated as initiation failure with raw responses stored; all money-moving operations are idempotent via ledger idempotency keys.

## 2. What was built

- **Adapter** `src/modules/payments/xdigitex.ts` — server-side-only client (`X-API-Key` from env), strict zod response validation, injectable `fetchImpl` for tests, timeout/HTTP/invalid-response error taxonomy.
- **Payments service** `src/modules/payments/service.ts` — deposit initiation (internal `PaymentRecord` written **before** any provider call), webhook processing (idempotent, verified), reconciliation sweeps, two-phase withdrawals (reserve → submit → settle/reverse), wallet→campaign funding, provider-balance snapshot, connection test (never reveals the key).
- **Ledger** — new accounts/journals: `org-funds-held` wallet, `ORG_DEPOSIT`, `WALLET_TO_CAMPAIGN`, `WITHDRAWAL_RESERVE`, `WITHDRAWAL_REVERSAL`; entry-level reference attribution (with backfill migration for pre-existing rows).
- **Routes** — `POST /api/webhooks/xdigitex` (secret-gated, rate-limited, audited `WebhookDelivery` records), `GET /api/payments/{ref}/status` (auth-scoped polling), `/payment/callback` (neutral landing).
- **UI** — business wallet + deposit panel (STK "check your phone" with live polling, redirect/crypto handoff), fund-campaign-from-wallet, worker withdrawal form with **3% fee + net payout shown before confirmation**, admin Payments dashboard (deposits/withdrawals/webhooks/provider balance/pending/uncertain), Reconciliation page (provider vs internal, safe sweep), Payment settings (masked key status, connection test, gateway toggles, withdrawal limits).
- **Worker** — reconciliation sweep every 5 minutes on both queue drivers.
- **Schema** — `PaymentRecord`, `WebhookDelivery`, `PlatformSetting` + migrations (`20261104204814_xdigitex_payments`, entry-refs, `20261105000000_backfill_entry_refs`).

## 3. Environment configuration

```
XDIGITEX_PAY_API_KEY=pg_xxx          # server-side only; empty = local sandbox mode
XDIGITEX_PAY_BASE_URL=https://pay.xdigitex.space/api
XDIGITEX_PAY_WEBHOOK_SECRET=...      # optional; our X-Webhook-Secret convention
XDIGITEX_PAY_TIMEOUT_MS=30000
APP_PUBLIC_URL=https://yourdomain    # builds callback_url / webhook_url
LIPAHUB_MIN_WITHDRAWAL_MINOR=1000    # admin-editable at runtime via settings page
LIPAHUB_MAX_WITHDRAWAL_MINOR=7000000
```
Webhook endpoint to register with the provider: `https://<APP_PUBLIC_URL>/api/webhooks/xdigitex`. The key is read from env at call time only — never stored in DB, never rendered, never logged.

## 4. Tests & verification

- **53/53 vitest tests pass** (30 pre-existing untouched + 23 new payment-integration tests): successful M-Pesa/Airtel/card/mobile deposits, failed payment, duplicate webhook, forged reference, amount mismatch, currency mismatch, delayed confirmation via reconciliation, provider timeout during verification, initiation failure, webhook-secret enforcement, withdrawal success/failure/duplicate-refusal, uncertain-withdrawal handling, ledger idempotency, wallet→campaign escrow, tenant isolation, wallet-overdraft rejection, provider-wallet reconciliation (delta 0), global journal-balance sweep, fee rounding.
- `tsc --noEmit` clean; `next build` succeeds with all payment routes.
- **Browser E2E (local mock provider emulating the documented API + firing real webhooks with the secret):** business deposit 1000 KES via M-Pesa STK → "check your phone" → webhook verified → wallet credited **880.00 KES net** → campaign funded 500 KES from wallet (`WALLET_TO_CAMPAIGN`) → worker withdrawal 20 KES with fee disclosure → admin "Approve & submit to provider" → reserve journal → provider `processing` → provider completed → admin reconciliation sweep → **PAID**, worker balance 5.00 KES. The reconciliation page correctly flagged the (test-data) delta for investigation instead of silently accepting it.

## 5. Honest testing status

| Integration | Status |
|---|---|
| Adapter contract, webhook verification, reconciliation, two-phase withdrawals, ledger integration | ✅ tested (mocked provider responses + browser E2E against a local mock emulating the documented API) |
| Real provider sandbox (`https://pay.xdigitex.space`) | ⚠️ **not yet exercised** — requires a KYC-verified account and `pg_...` API key. The admin "Test provider connection" button (`GET /balance`) is the designated first live check; go-live checklist: verify initiate → webhook delivery → status verification with real M-Pesa STK before enabling real funding. |
| Live money | 🚫 intentionally unreachable — sandbox/simulated modes only until the above is verified. |

## 6. Defects found & fixed during M1

- Entry-level ledger references were NULL for pre-M1 rows → backfill migration applied (balances restored).
- Withdrawal history fetch initially missed the `?page=` query in the mock → fixed in tests; confirmed adapter sends the documented path.
- Dev-server restart kept the old process (port conflict) during E2E → killed by port PID; not a code defect.

---

# Milestone 0 — Foundation (2026-11-04)

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
