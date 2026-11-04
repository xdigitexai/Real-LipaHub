/**
 * Verification module — evidence verification pipeline.
 *
 * Layer 1: DETERMINISTIC checks (always run, pure code):
 *   - completeness vs task evidenceRequirements
 *   - file/link validity shape
 *   - duplicate submission detection (content hash across platform)
 *   - self-duplicate detection
 *
 * Layer 2: AI-assisted review (Evidence Verification Agent) — only when
 *   a model is configured; its verdict can PASS/FAIL only at high
 *   confidence; otherwise escalates.
 *
 * Layer 3: HUMAN review for UNCERTAIN or admin moderation.
 *
 * Confidence threshold (default 70) is configurable per env/DB later.
 */
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { verifyEvidenceWithAgent } from "@/modules/ai/agents";
import type { Prisma } from "@prisma/client";

export interface VerificationCheck {
  id: string;
  label: string;
  passed: boolean | null; // null = not applicable / indeterminate
  detail: string;
}

export interface VerificationOutcome {
  verdict: "PASS" | "FAIL" | "UNCERTAIN";
  confidence: number;
  checks: VerificationCheck[];
  escalated: boolean;
  engine: "DETERMINISTIC" | "AI" | "HUMAN";
}

const CONFIDENCE_THRESHOLD = Number(process.env.LIPAHUB_VERIFICATION_THRESHOLD ?? 70);

export async function runVerification(
  tx: Prisma.TransactionClient,
  input: { submissionId: string; workerId: string; evidenceRequirements: string[] },
): Promise<VerificationOutcome> {
  const submission = await tx.submission.findUnique({ where: { id: input.submissionId } });
  if (!submission) throw Errors.notFound("Submission not found");
  const evidence = submission.evidence as Array<{ kind: string; label?: string; value: string }>;

  const checks: VerificationCheck[] = [];

  // 1. Completeness: at least one evidence item per requirement keyword
  const requirements = input.evidenceRequirements.filter((r) => r.trim().length > 0);
  if (requirements.length === 0) {
    checks.push({ id: "completeness", label: "Evidence completeness", passed: evidence.length > 0, detail: evidence.length > 0 ? `${evidence.length} evidence item(s) provided` : "No evidence provided" });
  } else {
    const covered = requirements.map((req) => {
      const needle = req.toLowerCase().split(/\s+/).slice(0, 3).join(" ");
      const found = evidence.some((e) => `${e.label ?? ""} ${e.value}`.toLowerCase().includes(needle.slice(0, Math.max(4, needle.length))));
      return { req, found };
    });
    const missing = covered.filter((c) => !c.found).map((c) => c.req);
    const passed = missing.length === 0 && evidence.length > 0;
    checks.push({
      id: "completeness",
      label: "Evidence completeness",
      passed: passed ? true : evidence.length === 0 ? false : null,
      detail: passed ? `All ${requirements.length} requirement(s) addressed` : missing.length > 0 ? `Possibly missing: ${missing.join("; ")}` : "No evidence provided",
    });
  }

  // 2. Link validity
  const links = evidence.filter((e) => e.kind === "link");
  const badLinks = links.filter((l) => !/^https?:\/\/.+\..+/.test(l.value));
  checks.push({
    id: "links",
    label: "Link validity",
    passed: links.length === 0 ? null : badLinks.length === 0,
    detail: links.length === 0 ? "No links submitted" : badLinks.length === 0 ? `${links.length} link(s) well-formed` : `${badLinks.length} malformed link(s)`,
  });

  // 3. Platform-wide duplicate detection (exact content hash by same or other workers)
  const dupes = await tx.submission.findMany({
    where: { contentHash: submission.contentHash, id: { not: submission.id } },
    select: { id: true, assignment: { select: { workerId: true, taskId: true } } },
    take: 5,
  });
  const crossWorkerDupe = dupes.some((d) => d.assignment.workerId !== input.workerId);
  checks.push({
    id: "duplicates",
    label: "Duplicate submission",
    passed: dupes.length === 0,
    detail: dupes.length === 0 ? "No identical prior submission" : crossWorkerDupe ? "Identical evidence submitted by a different worker" : `${dupes.length} identical earlier submission(s) by this worker`,
  });

  const hasHardFail = checks.some((c) => c.passed === false);
  const hasIndeterminate = checks.some((c) => c.passed === null);

  let outcome: VerificationOutcome;

  if (hasHardFail) {
    const failed = checks.filter((c) => c.passed === false).map((c) => c.label).join(", ");
    outcome = {
      verdict: "FAIL",
      confidence: 90,
      checks,
      escalated: false,
      engine: "DETERMINISTIC",
    };
    void failed;
  } else if (hasIndeterminate) {
    // Try AI layer before escalating; only high-confidence AI passes/fails
    const ai = await verifyEvidenceWithAgent({
      submissionId: submission.id,
      taskRequirements: requirements,
      evidence,
      checks,
    });
    if (ai && (ai.verdict === "PASS" || ai.verdict === "FAIL") && ai.confidence >= CONFIDENCE_THRESHOLD + 10) {
      outcome = { verdict: ai.verdict, confidence: ai.confidence, checks, escalated: false, engine: "AI" };
    } else {
      outcome = {
        verdict: "UNCERTAIN",
        confidence: ai ? Math.min(ai.confidence, CONFIDENCE_THRESHOLD - 5) : 40,
        checks,
        escalated: true,
        engine: ai ? "AI" : "DETERMINISTIC",
      };
    }
  } else {
    // All deterministic checks passed
    outcome = { verdict: "PASS", confidence: 85, checks, escalated: false, engine: "DETERMINISTIC" };
  }

  await tx.verificationRun.create({
    data: {
      submissionId: submission.id,
      engine: outcome.engine,
      checks: outcome.checks as never,
      confidence: outcome.confidence,
      verdict: outcome.verdict,
      escalated: outcome.escalated,
    },
  });

  await tx.submission.update({
    where: { id: submission.id },
    data: {
      status: outcome.verdict === "PASS" ? "AUTO_VERIFIED" : outcome.escalated ? "NEEDS_REVIEW" : "PENDING",
    },
  });

  // Assignment routing
  if (outcome.escalated || outcome.verdict === "UNCERTAIN") {
    await tx.assignment.update({
      where: { id: (await tx.submission.findUnique({ where: { id: submission.id }, select: { assignmentId: true } }))!.assignmentId },
      data: { status: "IN_REVIEW" },
    });
  }

  return outcome;
}

/** Human reviewer decision on an escalated submission (admin or business). */
export async function recordHumanVerification(input: {
  submissionId: string;
  reviewerId: string;
  verdict: "PASS" | "FAIL";
  note?: string;
}): Promise<void> {
  const submission = await prisma.submission.findUnique({ where: { id: input.submissionId } });
  if (!submission) throw Errors.notFound("Submission not found");
  await prisma.verificationRun.create({
    data: {
      submissionId: input.submissionId,
      engine: "HUMAN",
      checks: [{ id: "human", label: "Human review", passed: input.verdict === "PASS", detail: input.note ?? "Reviewed by moderator" }] as never,
      confidence: 100,
      verdict: input.verdict,
      escalated: false,
      reviewerId: input.reviewerId,
    },
  });
}
