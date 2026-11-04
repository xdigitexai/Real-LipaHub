# LipaHub AI — Architecture

> Status: v0.1 — foundation design (greenfield build)
> Date: 2026-11-04

## 0. Repository audit summary (honest)

The assigned workspace
(`C:\Users\Admin\.zcode\workspace\draft-e19ac50b-1330-4785-a814-0f92d275019e`)
was **empty** when this engagement started. No existing LipaHub source
repository, migrations, or deployment configuration were present in the
workspace. Scratch artefacts from earlier LipaHub-related work (PHP-era
deploy scripts under `C:\Users\Admin\tmpfx`) reference a separate legacy
PHP deployment that is not available as source here.

**Decision (confirmed by product owner): build LipaHub AI from scratch**
in this repository, as a standalone, reusable earning-automation engine
whose first tenant is the LipaHub marketplace itself. Nothing pre-existing
could be overwritten, so there is no risk to working features; all
"existing catalogue" references in the product brief map onto the
Opportunity Catalogue module defined below.

Environment verified on this machine: Node v24.20.0, npm 11.19.0,
Docker Desktop (containers used for PostgreSQL 17 + Redis 7). No native
psql/redis binaries. TypeScript-first stack chosen to match the platform
preferences in the product brief.

## 1. Architectural style

**Modular monolith** — one deployable Next.js application plus one
long-running worker process, with hard module boundaries. No
microservices until load demands it.

```
┌────────────────────────────────────────────────────────────────┐
│                     lipahub-ai repository                      │
│                                                                │
│  src/app        Next.js App Router UI + API route handlers     │
│  src/modules    Engine modules (domain logic, no framework     │
│                 imports at the core)                           │
│  src/jobs       BullMQ queue definitions + worker process      │
│  src/lib        Infrastructure adapters (db, redis, env,       │
│                 session, crypto, rate-limit, logger)           │
│  prisma         Schema + SQL migrations (PostgreSQL)           │
│  tests          Vitest unit + integration tests                │
│  scripts        Operational scripts (seed, create-admin)       │
│  docs           This documentation set                         │
└────────────────────────────────────────────────────────────────┘
```

### Module map (Phase 1 engine modules)

| Module | Path | Responsibility |
|---|---|---|
| identity | `src/modules/identity` | users, tenants, sessions, RBAC, verification states |
| opportunities | `src/modules/opportunities` | approved sources, discovery pipeline, dedupe, risk, moderation, catalogue |
| marketplace | `src/modules/marketplace` | organizations, campaigns, tasks, applications, assignments, submissions, reviews, disputes |
| workers | `src/modules/workers` | worker profiles, skills, completion history |
| finance | `src/modules/finance` | double-entry ledger, funding, reservations, payouts, withdrawals, provider adapters |
| ai | `src/modules/ai` | orchestrator, agent registry, model adapter, run/event tracking |
| verification | `src/modules/verification` | deterministic + AI-assisted evidence verification pipeline |
| automation | `src/modules/automation` | sandboxed task-execution contracts (Playwright) — Phase 5, interfaces only in v1 |
| notifications | `src/modules/notifications` | in-app notification records (email/push adapters later) |
| analytics | `src/modules/analytics` | aggregated counters and employer/worker stats |
| audit | `src/modules/audit` | append-only audit trail |

### Dependency rule

`app → modules → lib`. Modules may import other modules **only through
their public `index.ts` facade**. Core domain code must not import
`next/*`; UI/API layers call module services. This keeps the engine
reusable outside Next.js (worker process, CLI scripts).

## 2. Runtime topology

- **Web app**: Next.js 16 (App Router, server components + route
  handlers), port 4310.
- **Worker**: `npm run worker` — BullMQ processor consuming
  `discovery`, `evaluation`, `verification`, `operations` queues.
- **PostgreSQL 17**: primary datastore, all money moves inside DB
  transactions with row locks.
- **Redis 7**: BullMQ queues + rate limiting.
- **AI provider**: GLM-5.3-Flash via a swappable `ModelAdapter`
  (OpenAI-compatible HTTP), configured by env/DB, never hardcoded.

## 3. Key flows (vertical slice)

1. Business registers → org created (`PENDING_VERIFICATION`).
2. Admin verifies org.
3. Business creates campaign + tasks (`DRAFT`), funds campaign via
   payment provider adapter (M-Pesa sandbox simulator in v1) with an
   idempotency key → ledger journals move cash into
   `campaign-funds-held`.
4. Publishing a task **reserves** reward funds (escrow journal). Only
   funded campaigns can publish payable tasks.
5. Worker applies → business accepts → assignment opens.
6. Worker submits evidence → verification pipeline runs deterministic
   checks + optional AI verification → `PASS` / `FAIL` / `UNCERTAIN`
   (uncertain escalates to human review).
7. Business approves → ledger releases escrow to worker payable minus
   platform commission; worker balance updates; withdrawal request can
   be raised and approved by admin.
8. Opportunity intelligence: admin adds approved sources → discovery
   fetches → research agent extracts → trust & safety agent scores →
   moderation → approved + published to catalogue.

## 4. Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) | platform preference, single language |
| Web | Next.js 16 App Router | platform preference, SSR + API in one |
| DB | PostgreSQL + Prisma 7 (`@prisma/adapter-pg`) | typed schema, SQL migrations, transactional |
| Jobs | BullMQ + ioredis | platform preference, retries/DLQ |
| Money | Integer minor units (cents) + Decimal.js guards | deterministic accounting |
| Auth | Argon2id password hashing, opaque session tokens (SHA-256 stored), httpOnly cookies | revocable, no JWT leakage risk |
| AI | ModelAdapter interface, GLM-5.3-Flash default, zod-validated structured output | provider swap without code changes |
| Tests | Vitest (unit + DB integration), browser E2E via Playwright/ZCode tooling | platform preference |

## 5. Failure & recovery

- BullMQ: exponential backoff (3 retries default), dead-letter lists,
  Operations Agent monitors stalled/failed jobs and raises admin
  notifications.
- Ledger writes are append-only; corrections are reversing journals,
  never edits.
- Idempotency keys on every money-moving endpoint and job (unique
  constraint; replay returns original outcome).
- Health endpoint `/api/health` reports DB, Redis, queue depth.

## 6. What is deliberately NOT in v0.1

- Live M-Pesa ( Daraja production) credentials — sandbox adapter only.
- Playwright execution sandbox — interface defined, implementation
  gated behind Phase 5.
- Email/Push delivery — notification records only.
- Multi-region deployment, CDN, object storage for evidence files
  (local disk under `storage/` with DB-registered metadata).
