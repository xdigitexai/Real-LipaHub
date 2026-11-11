/**
 * Live end-to-end verification of the opportunity intelligence pipeline
 * against the configured AI provider (no mocks).
 *
 *  source → ingest (AI research extraction) → hard+AI trust scoring →
 *  moderation gate → human approval → published catalogue
 *
 * Usage: npx tsx scripts/verify-live-pipeline.ts
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { createSource, ingestSource, moderateOpportunity, listCatalogue } from "@/modules/opportunities/service";

const stamp = Date.now();

const BENIGN = {
  title: `Data entry of supplier invoices into spreadsheet (ref ${stamp})`,
  body:
    "We need 40 supplier invoices transcribed into our shared spreadsheet: date, supplier name, invoice number, " +
    "amount and VAT. Deliverable is a link to the completed sheet. Payment by bank transfer within 7 days of " +
    "approval. No fees are charged to workers at any point.",
  url: `https://work-board.example.com/data-entry/${stamp}`,
};

const SCAM = {
  title: `URGENT hiring: earn 6000 Ksh daily from your phone (ref ${stamp})`,
  body:
    "Register today by sending a 300 Ksh activation fee to our agent. Guaranteed daily earnings, no experience " +
    "needed. We pay in USDT only. Send us your WhatsApp number to join the recruitment group and invite friends " +
    "for bonuses.",
  url: `https://shady-listings.example.com/earn/${stamp}`,
};

async function main() {
  const admin = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: "admin@lipahub.local" } });
  const source = await createSource({ name: `Live AI verification ${stamp}`, kind: "MANUAL", trustLevel: "NEUTRAL" });

  console.log("── ingest benign listing ──");
  const r1 = await ingestSource({ sourceId: source.id, listings: [BENIGN], actorId: admin.id });
  console.log("ingest result:", JSON.stringify(r1));

  console.log("── ingest scam listing ──");
  const r2 = await ingestSource({ sourceId: source.id, listings: [SCAM], actorId: admin.id });
  console.log("ingest result:", JSON.stringify(r2));

  const rows = await prisma.discoveredOpportunity.findMany({
    where: { sourceId: source.id },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    const signals = (row.riskSignals as Array<{ signal: string }> | null) ?? [];
    console.log(
      `\n• ${row.title}\n  status=${row.status} risk=${row.riskScore}/${row.riskBand} confidence=${row.confidence}%` +
        `\n  category/requirements come from AI extraction; aiRunId=${row.aiRunId ?? "none"}` +
        `\n  signals=${signals.map((s) => s.signal).join(",") || "none"}` +
        `\n  reviewNote=${row.reviewNote ?? "—"}`,
    );
  }

  const benign = rows.find((r) => r.title.includes("supplier invoices"));
  if (!benign) throw new Error("benign row missing");

  console.log("\n── human approval → catalogue ──");
  await moderateOpportunity({ opportunityId: benign.id, adminId: admin.id, approve: true, note: "Live AI verification run" });
  const catalogue = await listCatalogue({ search: `ref ${stamp}` });
  console.log(`catalogue entries: ${catalogue.length}`);
  for (const c of catalogue) console.log(`  published: ${c.title} (risk ${c.riskScore})`);

  const runs = await prisma.agentRun.findMany({
    where: { agent: { in: ["research", "trust-safety"] }, createdAt: { gte: new Date(Date.now() - 5 * 60_000) } },
    select: { agent: true, status: true, model: true, tokensIn: true, tokensOut: true, latencyMs: true },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  console.log("\nrecent agent runs:");
  for (const r of runs) console.log(`  ${r.agent}: ${r.status} ${r.model} ${r.tokensIn}/${r.tokensOut} ${r.latencyMs}ms`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("pipeline verification failed:", String(e).slice(0, 600));
  process.exit(1);
});
