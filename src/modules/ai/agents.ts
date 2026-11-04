/**
 * Agent library — one file per agent responsibility, shared schemas.
 * Every agent is independently testable through runAgent with a stub
 * adapter (see tests). No agent has financial or publication powers:
 * they produce structured findings for humans/workflows to act on.
 */
import { z } from "zod";
import { runAgent, type AgentOutcome } from "./orchestrator";

// ── Research Agent ───────────────────────────────────────────────────

export const ResearchOutputSchema = z.object({
  title: z.string().min(4).max(200),
  description: z.string().min(10).max(4000),
  category: z.enum([
    "data-entry", "survey", "microtask", "content", "testing",
    "transcription", "design", "tutoring", "other",
  ]),
  rewardText: z.string().max(300).default("Not stated"),
  requirements: z.array(z.string().max(300)).max(12).default([]),
  eligibility: z.string().max(600).default("Not stated"),
  geoRestrictions: z.array(z.string().max(60)).max(20).default([]),
  suspiciousSignals: z.array(z.string().max(300)).max(10).default([]),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

export async function runResearchAgent(input: {
  sourceName: string;
  rawTitle: string;
  rawBody: string;
  url?: string;
}): Promise<AgentOutcome<ResearchOutput>> {
  return runAgent({
    agent: "research",
    purpose: "research",
    entityType: "discovered_opportunity",
    system: [
      "You are the LipaHub Research Agent. You extract structured data from publicly",
      "listed online-earning opportunities. Extract ONLY what the listing states —",
      "never invent rewards, employers or requirements. If a field is absent, use the",
      "documented default. Flag anything that looks like a scam signal in",
      "suspiciousSignals (upfront fees, guaranteed income, crypto-only payment,",
      "recruitment focus, unrealistic pay). Reply with ONLY a JSON object with keys:",
      "title, description, category, rewardText, requirements, eligibility,",
      "geoRestrictions, suspiciousSignals.",
    ].join(" "),
    user: [
      `Source: ${input.sourceName}`,
      input.url ? `URL: ${input.url}` : "",
      `Listing title: ${input.rawTitle}`,
      `Listing body:\n${input.rawBody.slice(0, 6000)}`,
    ].filter(Boolean).join("\n\n"),
    schema: ResearchOutputSchema,
  });
}

// ── Trust & Safety Agent ─────────────────────────────────────────────

export const TrustSafetyOutputSchema = z.object({
  riskScore: z.number().min(0).max(100),
  riskBand: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  signals: z.array(z.object({
    signal: z.string().max(200),
    severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
    explanation: z.string().max(400),
  })).max(12),
  explanation: z.string().min(10).max(1000),
  recommendApproval: z.boolean(),
});
export type TrustSafetyOutput = z.infer<typeof TrustSafetyOutputSchema>;

/**
 * Deterministic hard rules — applied in code BEFORE/AFTER the model so
 * safety never depends solely on model judgement.
 */
export function hardRiskRules(text: {
  title: string;
  description: string;
  rewardText?: string;
  eligibility?: string;
}): { score: number; signals: Array<{ signal: string; severity: "INFO" | "WARNING" | "CRITICAL"; explanation: string }> } {
  const blob = `${text.title} ${text.description} ${text.rewardText ?? ""} ${text.eligibility ?? ""}`.toLowerCase();
  const signals: Array<{ signal: string; severity: "INFO" | "WARNING" | "CRITICAL"; explanation: string }> = [];
  let score = 10;

  const add = (signal: string, severity: "INFO" | "WARNING" | "CRITICAL", explanation: string, bump: number) => {
    signals.push({ signal, severity, explanation });
    score += bump;
  };

  if (/(registration|signup|joining|activation|training|kit|starter)\s*(fee|charge|payment|cost)|pay\s+(a\s+)?(fee|deposit|registration)/.test(blob)) {
    add("upfront-payment", "CRITICAL", "Listing asks the worker to pay money upfront — classic advance-fee scam pattern.", 45);
  }
  if (/(guaranteed|assured)\s+(income|earnings|money|payment|daily|weekly)/.test(blob)) {
    add("guaranteed-income", "CRITICAL", "Claims guaranteed income; legitimate opportunities cannot guarantee earnings.", 40);
  }
  if (/(bitcoin|usdt|crypto|binance|wallet address)/.test(blob) && /only|exclusively/.test(blob)) {
    add("crypto-only", "WARNING", "Crypto-only payment requested; harder to trace and reverse.", 20);
  }
  if (/(recruit|invite|refer)\s+(others|friends|people)|pyramid|mlm/.test(blob)) {
    add("recruitment-focus", "WARNING", "Emphasis on recruiting others rather than performing work.", 25);
  }
  if (/(\$\s?\d{3,}(\.\d{2})?\s*(per day|daily|\/day))|(ksh\s?\d{2,},\d{3}\s*(per day|daily))/.test(blob)) {
    add("unrealistic-pay", "WARNING", "Payment claim is implausibly high for the described work.", 20);
  }
  if (/(whatsapp|telegram)\s+(group|only|link)/.test(blob)) {
    add("off-platform-redirect", "WARNING", "Redirects communication off-platform to unmoderated channels.", 10);
  }
  if (/(no experience|no skills|work from home)/.test(blob) && /(earn|income|money)/.test(blob) && /(daily|instant|immediately)/.test(blob)) {
    add("effort-pay-mismatch", "WARNING", "Pairs 'no effort' with immediate earnings — common scam framing.", 10);
  }

  return { score: Math.min(100, score), signals };
}

export function bandForScore(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score >= 70) return "CRITICAL";
  if (score >= 45) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

export async function runTrustSafetyAgent(input: {
  opportunityId: string;
  sourceTrustLevel: string;
  title: string;
  description: string;
  rewardText?: string;
  eligibility?: string;
}): Promise<AgentOutcome<TrustSafetyOutput>> {
  const hard = hardRiskRules(input);

  const outcome = await runAgent({
    agent: "trust-safety",
    purpose: "trust-safety",
    entityType: "discovered_opportunity",
    entityId: input.opportunityId,
    system: [
      "You are the LipaHub Trust & Safety Agent. Assess whether an earning opportunity",
      "is legitimate and safe for workers. Be conservative: when uncertain, raise the",
      "score. Explain every signal. Recommend approval ONLY for listings you judge safe.",
      "Hard-rule signals (already computed deterministically) must be reflected in your",
      "assessment. Reply with ONLY JSON: { riskScore (0-100), riskBand",
      "(LOW|MEDIUM|HIGH|CRITICAL), signals: [{signal, severity (INFO|WARNING|CRITICAL),",
      "explanation}], explanation, recommendApproval (boolean) }.",
    ].join(" "),
    user: [
      `Source trust level: ${input.sourceTrustLevel}`,
      `Title: ${input.title}`,
      `Description: ${input.description.slice(0, 4000)}`,
      `Reward terms: ${input.rewardText ?? "Not stated"}`,
      `Eligibility: ${input.eligibility ?? "Not stated"}`,
      `Deterministic hard-rule findings (must be included): ${JSON.stringify(hard.signals)}`,
      `Deterministic baseline score: ${hard.score}`,
    ].join("\n"),
    schema: TrustSafetyOutputSchema,
  });

  if (!outcome.ok) return outcome;

  // Safety floor: the model can never clear a hard-rule CRITICAL signal.
  const model = outcome.output;
  const floor = bandForScore(hard.score);
  const merged: TrustSafetyOutput = {
    riskScore: Math.max(model.riskScore, hard.score),
    riskBand: maxBand(model.riskBand, floor),
    signals: dedupeSignals([...model.signals, ...hard.signals]),
    explanation: model.explanation,
    recommendApproval: model.recommendApproval && hard.score < 45,
  };
  return { ...outcome, output: merged };
}

function maxBand(a: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL", b: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL") {
  const order = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function dedupeSignals(signals: Array<{ signal: string; severity: string; explanation: string }>) {
  const seen = new Set<string>();
  return signals.filter((s) => {
    if (seen.has(s.signal)) return false;
    seen.add(s.signal);
    return true;
  }).slice(0, 12) as TrustSafetyOutput["signals"];
}

// ── Evidence Verification Agent ──────────────────────────────────────

export const EvidenceVerificationOutputSchema = z.object({
  verdict: z.enum(["PASS", "FAIL", "UNCERTAIN"]),
  confidence: z.number().min(0).max(100),
  explanation: z.string().min(5).max(1000),
});

export interface EvidenceVerificationResult {
  verdict: "PASS" | "FAIL" | "UNCERTAIN";
  confidence: number;
  explanation: string;
}

/**
 * Returns null when the model is unavailable — callers must treat null
 * as "no AI layer" and fall back to deterministic/human review.
 */
export async function verifyEvidenceWithAgent(input: {
  submissionId: string;
  taskRequirements: string[];
  evidence: Array<{ kind: string; label?: string; value: string }>;
  checks: Array<{ id: string; label: string; passed: boolean | null; detail: string }>;
}): Promise<EvidenceVerificationResult | null> {
  const outcome = await runAgent({
    agent: "evidence-verification",
    purpose: "evidence-verification",
    entityType: "submission",
    entityId: input.submissionId,
    system: [
      "You are the LipaHub Evidence Verification Agent. Examine submitted evidence",
      "against the task requirements. You check plausibility and completeness — you",
      "cannot browse the web or open files; base the verdict on the evidence text and",
      "deterministic check results. If you cannot decide with confidence, reply",
      "UNCERTAIN. Never fabricate verification. Reply ONLY JSON:",
      "{ verdict: PASS|FAIL|UNCERTAIN, confidence: 0-100, explanation }.",
    ].join(" "),
    user: [
      `Task requirements: ${JSON.stringify(input.taskRequirements)}`,
      `Evidence submitted: ${JSON.stringify(input.evidence.map((e) => ({ kind: e.kind, label: e.label, value: e.value.slice(0, 500) })))}`,
      `Deterministic checks: ${JSON.stringify(input.checks)}`,
    ].join("\n"),
    schema: EvidenceVerificationOutputSchema,
    maxRetries: 0,
  });
  if (!outcome.ok) return null;
  return outcome.output;
}

// ── Matching Agent ───────────────────────────────────────────────────

export const MatchingOutputSchema = z.object({
  recommendations: z.array(z.object({
    taskId: z.string(),
    score: z.number().min(0).max(100),
    reason: z.string().max(300),
  })).max(20),
});

export async function runMatchingAgent(input: {
  workerId: string;
  skills: string[];
  country: string;
  experienceLevel: string;
  tasks: Array<{ id: string; title: string; category: string; skillsRequired: string[]; geoAllow: string[]; rewardText: string }>;
}): Promise<AgentOutcome<z.infer<typeof MatchingOutputSchema>>> {
  return runAgent({
    agent: "matching",
    purpose: "matching",
    entityType: "worker",
    entityId: input.workerId,
    system: [
      "You are the LipaHub Matching Agent. Rank open tasks for a worker by fit:",
      "skills overlap, category interest implied by profile, geography eligibility,",
      "reward fairness for effort. Only recommend tasks the worker is eligible for.",
      "Reply ONLY JSON: { recommendations: [{ taskId, score (0-100), reason }] }.",
    ].join(" "),
    user: [
      `Worker skills: ${JSON.stringify(input.skills)}`,
      `Country: ${input.country}`,
      `Experience: ${input.experienceLevel}`,
      `Open tasks: ${JSON.stringify(input.tasks)}`,
    ].join("\n"),
    schema: MatchingOutputSchema,
    maxRetries: 0,
  });
}
