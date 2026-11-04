# LipaHub AI — Product Specification

> Status: v0.1 — foundation (greenfield build, confirmed with product owner)
> Date: 2026-11-04

## 1. Product thesis

LipaHub AI connects three actors:

- **Workers** seeking legitimate online earning opportunities.
- **Businesses** needing affordable digital work completed.
- **An AI automation engine** that discovers, evaluates, matches,
  assists, verifies and reports — with humans deciding anything
  financial, uncertain or sensitive.

**Never advertised**: guaranteed income. All earnings language on the
platform is framed as opportunity, never promise.

## 2. Personas

| Persona | Goal | Key surfaces |
|---|---|---|
| Worker | find legit earning work, get paid reliably | discovery, assignments, evidence upload, reward ledger, withdrawals, disputes |
| Business | get digital tasks done affordably, control quality | campaign wizard, funding, applicant review, submission review, analytics, disputes |
| Admin (LipaHub ops) | keep the marketplace safe & solvent | source manager, opportunity moderation, org verification, ledger oversight, withdrawal approval, fraud review, agent monitoring, audit log |

## 3. Core product surfaces

### 3.1 Opportunity intelligence (Stage 1 deliverable)

Admin adds an **approved source** (RSS/HTML/API/manual). The engine:

1. Fetches (rate-limited, robots-respecting, per-source interval).
2. Research Agent extracts title, description, requirements, reward
   terms, eligibility, geo restrictions (structured, validated).
3. Dedupe (URL hash + fuzzy title hash) marks duplicates.
4. Trust & Safety Agent produces an explainable risk assessment:
   signals, score 0–100, verdict `LOW|MEDIUM|HIGH|CRITICAL`; upfront
   payment / guaranteed-income claims are hard-flagged.
5. Everything lands in a moderation queue. Admin reviews AI findings
   and approves or rejects with a reason. Approval publishes the
   opportunity to the **Worker Catalogue**.
6. No external job, employer or earning amount is ever fabricated:
   everything traces to a fetched source record with attribution and
   timestamps.

### 3.2 Marketplace (campaign → reward)

Business lifecycle: register → verify (admin) → create campaign →
define tasks & deliverables → fund campaign (sandbox M-Pesa in v1) →
publish tasks (funds reserved) → receive applications → accept workers →
review submissions (with verification engine report) → approve/reject
with explanation → handle disputes → analytics.

Worker lifecycle: register → profile & skills → discover opportunities
(catalogue + matched tasks) → apply → receive instructions → (optional)
AI assistance → submit evidence → track verification → reward ledger →
withdrawal request → support/dispute centre.

**Hard rule: only funded campaigns can create payable work.**
Publishing a payable task reserves funds; approving releases them;
rejecting/cancelling releases back to campaign balance.

### 3.3 Financial integrity

- Double-entry ledger, integer minor units, immutable journals.
- Money only moves via typed journal kinds: `CAMPAIGN_FUNDING`,
  `TASK_RESERVATION`, `RESERVATION_RELEASE`, `REWARD_PAYOUT`,
  `COMMISSION`, `WITHDRAWAL`, `REFUND`, `ADJUSTMENT` (admin, reason
  required, human-approved).
- Worker-visible balance is a derived read of `worker-payable`
  account — never an editable column.
- Withdrawals require admin approval; provider callbacks are verified
  against expected amounts and recorded before state transitions.

### 3.4 AI agents (orchestrated, restricted)

| Agent | Permission scope | Human gate |
|---|---|---|
| Discovery/Research | read sources, write discovered rows | none (moderation queue catches output) |
| Trust & Safety | read+score, never publish | all MEDIUM+ requires admin approval; CRITICAL auto-reject suggestion |
| Matching | read tasks+profiles, write recommendations | none (advisory) |
| Task Execution | bounded Playwright sandbox, allowed-domains allowlist, action log, time budget | job-level authorization by business+admin policy |
| Evidence Verification | read submissions, write verdict | UNCERTAIN → human review |
| Support | read tickets/context, draft replies | sends only via notification records |
| Operations | retries, alerts | alerts admins for anomalies |

All runs: structured input/output (zod-validated), timeouts, bounded
retries, token accounting, audit events. AI never writes to the
ledger or payment state.

## 4. Non-functional requirements

- Tenant isolation: org data scoped by `organizationId` on every query;
  tests prove cross-org reads fail.
- RBAC: `ADMIN > BUSINESS(staff of org) > WORKER` with route-level and
  service-level checks.
- Rate limiting on auth + AI + submission endpoints (Redis token
  bucket).
- Audit trail for every state transition of money, moderation and
  identity.
- Accessibility: semantic forms, labelled inputs, visible focus,
  responsive down to 360px.

## 5. Acceptance (first vertical slice)

End-to-end, on real persistence, demonstrated in a browser:

1. Admin account seeded; logs in.
2. Business registers; admin verifies the org.
3. Business creates a campaign and a task; funds the campaign in
   sandbox; publishes the task (reservation visible in ledger).
4. Worker registers, applies; business accepts.
5. Worker submits evidence; verification engine returns a structured
   verdict; business approves.
6. Ledger shows reward + commission journals; worker reward ledger and
   balance reflect payout; admin sees the full trail.
7. Admin adds an opportunity source; discovery produces entries; AI
   evaluation (or honest `UNAVAILABLE` when no key) routes them to
   moderation; admin approves → appears in worker catalogue.
