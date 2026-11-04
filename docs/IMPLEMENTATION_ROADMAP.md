# LipaHub AI — Implementation Roadmap

> Status: v0.1 — living document, updated at every milestone

## Milestone 0 — Foundation ✅ (this delivery)
- [x] Environment audit (Node 24, npm 11, Docker Desktop for PG17+Redis7)
- [x] Repo scaffold, git, strict TypeScript, Next.js 16 + Prisma 7
- [x] Docs: ARCHITECTURE / PRODUCT_SPEC / DATABASE_DESIGN / SECURITY_MODEL
- [x] Prisma schema + initial migration (all v0.1 tables)
- [x] Identity: argon2id auth, DB-backed sessions, RBAC guards
- [x] Finance engine: double-entry ledger, idempotency, funding,
      reservations, commission, withdrawals + invariant tests
- [x] Marketplace: campaigns→tasks→applications→assignments→submissions
      →reviews + tenant-isolation tests
- [x] Verification pipeline: deterministic checks + confidence
      thresholds + escalation
- [x] Opportunity intelligence: sources, fetch pipeline, dedupe,
      trust scoring, moderation, catalogue publish
- [x] AI orchestration: ModelAdapter (GLM-5.3-Flash default via env),
      agent registry, run tracking, graceful UNAVAILABLE without keys
- [x] BullMQ queues + worker + Operations monitor
- [x] UI: auth, worker, business, admin dashboards (real data)
- [x] Vitest unit + DB integration tests; browser E2E of the vertical
      slice

## Milestone 1 — Opportunity intelligence hardening (next)
- Real RSS/HTML fetchers with robots.txt parsing + per-source rate
  limits; source health metrics; fuzzy dedupe threshold tuning.
- Research/Trust agent prompt library with regression fixtures.

## Milestone 2 — Business self-serve depth
- Campaign wizard multi-step UI, applicant ranking (Matching Agent),
  bulk acceptance, deadline reminders, employer analytics charts.

## Milestone 3 — Payments (sandbox→live gate)
- Daraja M-Pesa sandbox STK push + callback verification with
  signature checks; reconciliation job; then live-credentials
  checklist (business permit, KYC, compliance) before enabling.

## Milestone 4 — Task automation sandbox
- Playwright runner with per-job domain allowlists, action logs,
  time budgets, cancellation; Evidence Verification integration.

## Milestone 5 — Notifications & support
- Email adapter (SMTP), in-app centre, Support Agent drafts,
  dispute workflow UI completion.

## Milestone 6 — Ops & deployment
- Backups (pg_dump schedule), monitoring dashboards, queue recovery
  runbook, deployment docs, rollback procedure.

## Verification discipline (every milestone)
1. `npm run typecheck` clean
2. `npm test` green (unit + DB integration)
3. `npm run build` clean
4. Boot dev server + worker, complete the browser workflow
5. Milestone report: files, DB changes, test results, defects, risks
