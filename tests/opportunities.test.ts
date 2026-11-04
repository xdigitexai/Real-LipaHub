/**
 * Opportunity intelligence tests — dedupe, hard rules, moderation gate,
 * AI-unavailable honesty. AI is stubbed via adapter replacement.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { ensureChartOfAccounts } from "@/modules/finance";
import { createSource, ingestSource, moderateOpportunity, listCatalogue, titleFuzzyHash, parseRss } from "@/modules/opportunities/service";
import { hardRiskRules, bandForScore, runResearchAgent } from "@/modules/ai/agents";
import { setAdaptersForTesting, type ModelAdapter, type CompletionResult, ModelUnavailableError } from "@/modules/ai/adapter";
import { extractJson } from "@/modules/ai/orchestrator";
import type { z } from "zod";
import type { ResearchOutput } from "@/modules/ai/agents";

const unique = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const LISTING = {
  title: "Earn 5000 Ksh daily from home no experience needed",
  body: "Join our WhatsApp group, pay a small registration fee of 500 Ksh to activate your account and start earning guaranteed income today. We pay via crypto only.",
  url: "https://scam.example.com/listing/1",
};

function fakeResearchAdapter(output: Partial<ResearchOutput>): ModelAdapter {
  return {
    provider: "stub",
    async complete(req: { purpose: string; user: string }): Promise<CompletionResult> {
      // Echo the raw listing title so every ingest row is unique across
      // tests AND across repeated runs against the same database.
      const rawTitle = req.user.match(/Listing title: (.*)/)?.[1] ?? "Stub listing title";
      const full: ResearchOutput = {
        title: output.title ?? rawTitle,
        description: output.description ?? `Stub description for: ${rawTitle}`,
        category: output.category ?? "microtask",
        rewardText: output.rewardText ?? "500 KES per task",
        requirements: output.requirements ?? ["Complete the form"],
        eligibility: output.eligibility ?? "Open to Kenya",
        geoRestrictions: output.geoRestrictions ?? [],
        suspiciousSignals: output.suspiciousSignals ?? [],
      };
      return {
        text: JSON.stringify(full),
        provider: "stub",
        model: "stub-model",
        tokensIn: 10,
        tokensOut: 10,
        latencyMs: 5,
      };
    },
  } as unknown as ModelAdapter;
}

beforeAll(async () => {
  await ensureChartOfAccounts();
  // Ensure the stub provider is what purposes resolve to
  await prisma.modelConfig.upsert({
    where: { purpose: "research" },
    update: { provider: "stub", enabled: true, model: "stub-model" },
    create: { purpose: "research", provider: "stub", model: "stub-model" },
  });
  await prisma.modelConfig.upsert({
    where: { purpose: "trust-safety" },
    update: { provider: "stub", enabled: true, model: "stub-model" },
    create: { purpose: "trust-safety", provider: "stub", model: "stub-model" },
  });
});

afterEach(() => {
  // restore "no adapters" state between tests
});

describe("hard risk rules (deterministic, model-independent)", () => {
  it("flags upfront payment and guaranteed income as CRITICAL", () => {
    const hard = hardRiskRules({ title: LISTING.title, description: LISTING.body });
    const names = hard.signals.map((s) => s.signal);
    expect(names).toContain("upfront-payment");
    expect(names).toContain("guaranteed-income");
    expect(names).toContain("off-platform-redirect");
    expect(hard.score).toBeGreaterThanOrEqual(70);
    expect(bandForScore(hard.score)).toBe("CRITICAL");
  });

  it("scores a benign listing low", () => {
    const hard = hardRiskRules({
      title: "Data entry of invoices into spreadsheet",
      description: "Transcribe 40 invoice records into our shared sheet. Weekly payment via bank transfer.",
    });
    expect(hard.score).toBeLessThan(25);
    expect(bandForScore(hard.score)).toBe("LOW");
  });
});

describe("AI unavailable is honest", () => {
  it("research agent reports UNAVAILABLE with no adapters", async () => {
    setAdaptersForTesting(new Map());
    const outcome = await runResearchAgent({ sourceName: "s", rawTitle: "t", rawBody: "b" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("UNAVAILABLE");
      const run = await prisma.agentRun.findUnique({ where: { id: outcome.runId } });
      expect(run!.status).toBe("UNAVAILABLE");
    }
  });
});

describe("ingest pipeline", () => {
  // Run-unique listing text so repeated runs against the persistent DB
  // are never confused for duplicates by the fuzzy matcher.
  const runStamp = Date.now();

  it("extracts via stub AI, flags scam, routes to moderation, blocks auto-publish", async () => {
    setAdaptersForTesting(new Map([["stub", fakeResearchAdapter({ suspiciousSignals: ["Upfront fee request"] })]]));
    const admin = await prisma.user.create({
      data: { email: unique("adm"), emailNormalized: unique("adm"), passwordHash: "x", name: "Admin", role: "ADMIN" },
    });
    const source = await createSource({ name: unique("Source"), kind: "MANUAL" });
    const listing = {
      title: `${LISTING.title} (ref ${runStamp})`,
      body: LISTING.body,
      url: `https://scam.example.com/listing/${runStamp}`,
    };
    const result = await ingestSource({ sourceId: source.id, listings: [listing], actorId: admin.id });
    expect(result.discovered).toBe(1);
    expect(result.pendingReview).toBe(1);

    const rows = await prisma.discoveredOpportunity.findMany({ where: { sourceId: source.id } });
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.status).toBe("PENDING_REVIEW");
    // Raw scam text drives hard rules even though the stub AI output is benign
    expect(row.riskBand).toBe("CRITICAL");
    // Title comes from AI extraction (echoes the raw listing title)
    expect(row.title).toBe(listing.title);
    // Nothing published yet — moderation gate
    const publishedCount = await prisma.discoveredOpportunity.count({ where: { sourceId: source.id, status: "PUBLISHED" } });
    expect(publishedCount).toBe(0);

    // Admin approves → published to catalogue
    await moderateOpportunity({ opportunityId: row.id, adminId: admin.id, approve: true, note: "Verified source" });
    const catalogue = await listCatalogue({ search: `ref ${runStamp}` });
    expect(catalogue.some((c) => c.id === row.id)).toBe(true);
  });

  it("detects duplicates within and across ingests", async () => {
    setAdaptersForTesting(new Map([["stub", fakeResearchAdapter({})]]));
    const source = await createSource({ name: unique("DupSource"), kind: "MANUAL" });
    const listing = { title: `Unique title for duplicate test ${runStamp}`, body: "Body describing work", url: `https://dup-test.example.com/${runStamp}` };
    const first = await ingestSource({ sourceId: source.id, listings: [listing] });
    expect(first.discovered).toBe(1);
    const second = await ingestSource({ sourceId: source.id, listings: [listing] });
    expect(second.discovered).toBe(0);
    expect(second.duplicates).toBe(1);

    // Same title, different URL/source → fuzzy duplicate
    const other = await createSource({ name: unique("DupSource2"), kind: "MANUAL" });
    const third = await ingestSource({ sourceId: other.id, listings: [{ ...listing, url: `https://other.example.com/${runStamp}` }] });
    expect(third.discovered).toBe(0);
    expect(third.duplicates).toBe(1);
  });

  it("AI-unavailable ingest keeps rows honest and still routes to moderation", async () => {
    setAdaptersForTesting(new Map());
    const source = await createSource({ name: unique("NoAiSource"), kind: "MANUAL" });
    const result = await ingestSource({
      sourceId: source.id,
      listings: [{ title: `No AI listing title ${runStamp}`, body: "Simple body text for the listing", url: `https://noai.example.com/${runStamp}` }],
    });
    expect(result.unavailable).toBe(true);
    expect(result.pendingReview).toBe(1);
    const row = await prisma.discoveredOpportunity.findFirst({ where: { sourceId: source.id } });
    expect(row!.aiRunId).toBeNull();
    expect(row!.status).toBe("PENDING_REVIEW");
    expect(row!.confidence).toBeLessThan(30);
  });
});

describe("rss parsing", () => {
  it("extracts items from an RSS feed", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Freelance transcription work</title><description><![CDATA[Transcribe audio files for $0.60 per audio minute]]></description><link>https://jobs.example.com/1</link></item>
      <item><title>Survey panel</title><description>&amp; paid surveys</description><link>https://jobs.example.com/2</link></item>
    </channel></rss>`;
    const items = parseRss(xml, "https://feed.example.com");
    expect(items.length).toBe(2);
    expect(items[0].title).toBe("Freelance transcription work");
    expect(items[0].body).toContain("Transcribe audio files");
    expect(items[0].url).toBe("https://jobs.example.com/1");
  });
});

describe("json extraction", () => {
  it("parses fenced and embedded JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here is the JSON: {"a":{"b":2}} hope it helps')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("title fuzzy hash", () => {
  it("matches near-identical titles regardless of order/stopwords", () => {
    expect(titleFuzzyHash("Earn money typing daily from home")).toBe(titleFuzzyHash("Typing Daily From Home — Earn Money"));
    expect(titleFuzzyHash("Earn money typing daily")).not.toBe(titleFuzzyHash("Graphic design for logos"));
  });
});
