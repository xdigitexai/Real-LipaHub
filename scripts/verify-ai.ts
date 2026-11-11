/**
 * Live AI provider verification — runs the REAL agents through the
 * configured adapter (no mocks) and prints the structured result.
 *
 * Usage: npx tsx scripts/verify-ai.ts
 * Requires the provider key (e.g. DEEPSEEK_API_KEY) in the environment.
 * Never prints the key.
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { isModelConfigured, resolveModelConfig } from "@/modules/ai/adapter";
import { runResearchAgent, runTrustSafetyAgent, hardRiskRules } from "@/modules/ai/agents";

const SAMPLE = {
  sourceName: "Verification sample",
  title: "Freelance transcription work - Swahili audio, paid weekly",
  body:
    "Established localization agency seeking Swahili audio transcription for documentary subtitles. " +
    "Payment via bank transfer weekly based on accepted audio minutes. Applicants should describe previous " +
    "transcription experience. No fees are charged at any stage.",
  url: "https://agency-jobs.example.com/verify-sample",
};

const SCAM = {
  sourceName: "Verification sample (scam pattern)",
  title: "URGENT: Earn 5000 Ksh daily from home - no experience needed",
  body:
    "Join our WhatsApp group. Pay a small registration fee of 500 Ksh to activate your account and start " +
    "earning guaranteed income immediately. Work from home, no skills required. We pay via crypto only. " +
    "Invite your friends to earn even more.",
  url: "https://suspicious.example.com/verify-scam",
};

async function main() {
  const configured = await isModelConfigured();
  const cfg = await resolveModelConfig("research");
  console.log(`provider=${cfg.provider} model=${cfg.model} configured=${configured}`);
  if (!configured) {
    console.error("No AI credentials for the configured provider — nothing to verify.");
    process.exit(2);
  }

  console.log("\n[1/3] Research Agent — legitimate listing");
  const research = await runResearchAgent({
    sourceName: SAMPLE.sourceName,
    rawTitle: SAMPLE.title,
    rawBody: SAMPLE.body,
    url: SAMPLE.url,
  });
  if (!research.ok) {
    console.error("  FAILED:", research.reason, research.error ?? "");
    process.exit(1);
  }
  console.log(`  run=${research.runId} model=${research.model} tokens=${research.tokensIn}/${research.tokensOut} latency=${research.latencyMs}ms`);
  console.log("  output:", JSON.stringify(research.output).slice(0, 500));

  console.log("\n[2/3] Trust & Safety Agent — scam pattern (deterministic floor applies)");
  const hard = hardRiskRules({ title: SCAM.title, description: SCAM.body });
  console.log(`  deterministic baseline score=${hard.score} signals=${hard.signals.map((s) => s.signal).join(",")}`);
  const trust = await runTrustSafetyAgent({
    opportunityId: "verify-sample",
    sourceTrustLevel: "NEUTRAL",
    title: SCAM.title,
    description: SCAM.body,
    rewardText: "5000 Ksh daily",
    eligibility: "Open to all",
  });
  if (!trust.ok) {
    console.error("  FAILED:", trust.reason, trust.error ?? "");
    process.exit(1);
  }
  console.log(`  run=${trust.runId} model=${trust.model} tokens=${trust.tokensIn}/${trust.tokensOut} latency=${trust.latencyMs}ms`);
  console.log(`  riskScore=${trust.output.riskScore} band=${trust.output.riskBand} recommendApproval=${trust.output.recommendApproval}`);
  console.log(`  explanation: ${trust.output.explanation.slice(0, 300)}`);

  const safeToProceed = trust.output.riskBand === "CRITICAL" && trust.output.recommendApproval === false;
  console.log(`\n[3/3] Safety floor check: scam flagged CRITICAL and not approvable → ${safeToProceed ? "PASS" : "FAIL"}`);

  const runs = await prisma.agentRun.findMany({
    where: { id: { in: [research.runId, trust.runId] } },
    select: { agent: true, status: true, model: true, tokensIn: true, tokensOut: true, latencyMs: true },
  });
  console.log("\nPersisted agent runs:");
  for (const r of runs) console.log(`  ${r.agent}: ${r.status} ${r.model} ${r.tokensIn}/${r.tokensOut} ${r.latencyMs}ms`);

  await prisma.$disconnect();
  if (!safeToProceed) process.exit(1);
}

main().catch((e) => {
  console.error("verify-ai failed:", String(e).slice(0, 500));
  process.exit(1);
});
