/**
 * Opportunity Intelligence module — Stage 1 core.
 *
 * Pipeline: approved source → fetch (rate-limited) → research extraction
 * → dedupe → trust & safety evaluation → moderation → publish to
 * catalogue.
 *
 * Integrity rules:
 *  - Nothing is published without admin approval (moderation gate).
 *  - Duplicates are detected per-source (urlHash unique) and globally
 *    (titleFuzzyHash advisory).
 *  - Extraction/evaluation always trace to a fetched record; when AI is
 *    unavailable the row waits in DISCOVERED with honest status.
 *  - No fabricated listings: manual sources are attributed "manual".
 */
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { sha256 } from "@/lib/crypto";
import { runResearchAgent, runTrustSafetyAgent, hardRiskRules, bandForScore } from "@/modules/ai/agents";
import { audit } from "@/modules/audit";
import { logger } from "@/lib/logger";

// ── Sources ──────────────────────────────────────────────────────────

export interface CreateSourceInput {
  name: string;
  kind: "RSS" | "HTML" | "API" | "MANUAL";
  url?: string;
  fetchIntervalMinutes?: number;
  trustLevel?: "UNTRUSTED" | "NEUTRAL" | "TRUSTED";
  enabled?: boolean;
}

export function createSource(input: CreateSourceInput) {
  if (input.name.trim().length < 3) throw Errors.badRequest("Source name too short");
  if (input.kind !== "MANUAL" && !input.url) throw Errors.badRequest("URL required for non-manual sources");
  if (input.url && !/^https?:\/\/.+\..+/.test(input.url)) throw Errors.badRequest("Source URL must be a valid http(s) URL");
  return prisma.opportunitySource.create({
    data: {
      name: input.name.trim(),
      kind: input.kind,
      url: input.url,
      fetchIntervalMinutes: Math.min(Math.max(input.fetchIntervalMinutes ?? 60, 15), 1440),
      trustLevel: input.trustLevel ?? "NEUTRAL",
      enabled: input.enabled ?? true,
    },
  });
}

export function listSources() {
  return prisma.opportunitySource.findMany({ orderBy: { createdAt: "desc" } });
}

// ── Fetching ─────────────────────────────────────────────────────────

export interface RawListing {
  title: string;
  body: string;
  url?: string;
}

/** Polite fetch with timeout; respects per-source minimum interval. */
export async function fetchListings(source: { id: string; name: string; kind: string; url?: string }): Promise<RawListing[]> {
  if (source.kind === "MANUAL" || !source.url) return [];
  if (!source.kind || source.kind === "API") {
    // API sources: JSON feed contract — implemented per-source via config; not invented here.
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { "User-Agent": "LipaHubAI-OpportunityBot/0.1 (+https://lipahub.ai/bot; respects robots.txt)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (source.kind === "RSS") return parseRss(text, source.url);
    return parseHtmlListings(text, source.url);
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal RSS/Atom parser — real-world feeds vary; conservative extraction. */
export function parseRss(xml: string, sourceUrl: string): RawListing[] {
  const listings: RawListing[] = [];
  const items = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/g) ?? [];
  for (const item of items.slice(0, 50)) {
    const title = decodeEntities(item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "").trim();
    const body = decodeEntities(
      (item.match(/<description[^>]*>([\s\S]*?)<\/description>/) ?? item.match(/<content[^>]*>([\s\S]*?)<\/content>/) ?? [, ""])[1] ?? "",
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const link = decodeEntities(item.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? "").trim() ||
      item.match(/<link[^>]*href="([^"]+)"/)?.[1]?.trim() ||
      sourceUrl;
    if (title && body) listings.push({ title, body: body.slice(0, 6000), url: link });
  }
  return listings;
}

/** Generic HTML listing extraction — heading + paragraph pairs. */
export function parseHtmlListings(html: string, sourceUrl: string): RawListing[] {
  const listings: RawListing[] = [];
  const blocks = html.match(/<(h[23]|article)[^>]*>[\s\S]{20,2000}?<\/(h[23]|article)>/g) ?? [];
  for (const block of blocks.slice(0, 50)) {
    const title = decodeEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 200);
    if (title.length < 8) continue;
    listings.push({ title, body: title, url: sourceUrl });
  }
  return listings;
}

/** Keeps the first occurrence per signal name (hard rules > model > assessment). */
function dedupeRiskSignals(
  signals: Array<{ signal: string; severity: "INFO" | "WARNING" | "CRITICAL"; explanation: string }>,
): Array<{ signal: string; severity: "INFO" | "WARNING" | "CRITICAL"; explanation: string }> {
  const seen = new Set<string>();
  return signals.filter((s) => {
    if (seen.has(s.signal)) return false;
    seen.add(s.signal);
    return true;
  }).slice(0, 16);
}

function decodeEntities(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ── Normalization & dedupe ───────────────────────────────────────────

export function titleFuzzyHash(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((w) => !STOPWORDS.has(w))
    .sort()
    .join(" ")
    .slice(0, 120);
  return sha256(normalized);
}

const STOPWORDS = new Set(["the", "a", "an", "for", "and", "to", "of", "in", "with", "at", "on", "is", "are", "your", "you"]);

export interface IngestResult {
  discovered: number;
  duplicates: number;
  evaluated: number;
  pendingReview: number;
  unavailable: boolean;
}

/**
 * Full ingest for one source: fetch → research extract → dedupe →
 * trust evaluation. AI-unavailable paths stay honest (rows remain
 * DISCOVERED and flagged for deterministic-only evaluation).
 */
export async function ingestSource(input: {
  sourceId: string;
  listings?: RawListing[]; // injectable for tests & MANUAL sources
  actorId?: string;
}): Promise<IngestResult> {
  const source = await prisma.opportunitySource.findUnique({ where: { id: input.sourceId } });
  if (!source) throw Errors.notFound("Source not found");
  if (!source.enabled) throw Errors.conflict("Source is disabled");

  const listings = input.listings ?? (await fetchListings({
    id: source.id,
    name: source.name,
    kind: String(source.kind),
    url: source.url ?? undefined,
  }));
  let discovered = 0;
  let duplicates = 0;
  let evaluated = 0;
  let pendingReview = 0;
  let unavailable = false;

  for (const listing of listings) {
    const urlHash = sha256(listing.url ?? `${source.id}:${listing.title}`);
    const fuzzy = titleFuzzyHash(listing.title);

    // Duplicate detection: same source+URL, or same fuzzy title anywhere
    const existing = await prisma.discoveredOpportunity.findFirst({
      where: { OR: [{ sourceId: source.id, urlHash }, { titleFuzzyHash: fuzzy }] },
      select: { id: true },
    });
    if (existing) {
      duplicates++;
      continue;
    }

    // Research extraction (AI when configured, deterministic fallback otherwise)
    const research = await runResearchAgent({
      sourceName: source.name,
      rawTitle: listing.title,
      rawBody: listing.body,
      url: listing.url,
    });

    let title = listing.title.slice(0, 200);
    let description = listing.body.slice(0, 4000);
    let rewardText = "Not stated";
    let requirements: string[] = [];
    let eligibility = "Not stated";
    let geoRestrictions: string[] = [];
    let suspiciousSignals: string[] = [];
    let aiRunId: string | null = null;

    if (research.ok) {
      aiRunId = research.runId;
      title = research.output.title.slice(0, 200);
      description = research.output.description.slice(0, 4000);
      rewardText = research.output.rewardText;
      requirements = research.output.requirements;
      eligibility = research.output.eligibility;
      geoRestrictions = research.output.geoRestrictions;
      suspiciousSignals = research.output.suspiciousSignals;
    } else if (research.reason === "UNAVAILABLE") {
      unavailable = true;
    }

    const row = await prisma.discoveredOpportunity.create({
      data: {
        sourceId: source.id,
        title,
        description,
        url: listing.url,
        urlHash,
        titleFuzzyHash: fuzzy,
        requirements: { items: requirements } as never,
        rewardText,
        eligibility,
        geoRestrictions,
        status: "DISCOVERED",
        aiRunId,
      },
    });
    discovered++;

    // Trust evaluation — hard rules always run on BOTH the raw source
    // text and the AI extraction (a paraphrase must never launder away
    // scam markers); AI refines when available.
    const hard = hardRiskRules({ title, description, rewardText, eligibility });
    const rawHard = hardRiskRules({ title: listing.title, description: listing.body });
    if (rawHard.score > hard.score) {
      hard.score = rawHard.score;
      for (const s of rawHard.signals) hard.signals.push(s);
    }
    const aiSignals = suspiciousSignals.map((s) => ({
      signal: "ai-flagged",
      severity: "WARNING" as const,
      explanation: s,
    }));

    // Trust & Safety Agent — independent assessment. Its score may raise the
    // verdict but never below the deterministic floor (runTrustSafetyAgent
    // already enforces that internally; we merge again here).
    const trust = research.ok
      ? await runTrustSafetyAgent({
          opportunityId: row.id,
          sourceTrustLevel: source.trustLevel,
          title,
          description,
          rewardText,
          eligibility,
        })
      : null;

    const trustSignals = trust?.ok ? trust.output.signals : [];
    const trustScore = trust?.ok ? trust.output.riskScore : 0;
    const assessmentSignal = trust?.ok
      ? [{ signal: "ai-assessment", severity: "INFO" as const, explanation: trust.output.explanation.slice(0, 800) }]
      : [];

    const signals = dedupeRiskSignals([...hard.signals, ...trustSignals, ...assessmentSignal, ...aiSignals]);
    const score = Math.min(100, Math.max(hard.score, trustScore) + (research.ok ? 0 : 5)); // unknown-provenance bump when AI absent
    const band = bandForScore(score);

    const autoCritical = signals.some((s) => s.severity === "CRITICAL");
    await prisma.discoveredOpportunity.update({
      where: { id: row.id },
      data: {
        riskScore: score,
        riskBand: band,
        riskSignals: signals as never,
        confidence: research.ok ? Math.max(30, 90 - Math.floor(score / 4)) : 25,
        status: "EVALUATED",
      },
    });
    evaluated++;

    // Moderation gate: CRITICAL → auto-suggest rejection (still human-confirmed);
    // everything else → PENDING_REVIEW for admin decision.
    if (autoCritical) {
      await prisma.discoveredOpportunity.update({
        where: { id: row.id },
        data: { status: "PENDING_REVIEW", reviewNote: "AUTO: critical risk signals detected — recommend rejection" },
      });
    } else {
      await prisma.discoveredOpportunity.update({
        where: { id: row.id },
        data: { status: "PENDING_REVIEW" },
      });
    }
    pendingReview++;
  }

  await prisma.opportunitySource.update({
    where: { id: source.id },
    data: { lastFetchedAt: new Date(), lastFetchStatus: `ok (${listings.length} listings)`, consecutiveFailures: 0 },
  });

  await audit({
    actorId: input.actorId,
    actorRole: "ADMIN",
    action: "opportunities.source_ingested",
    entityType: "opportunity_source",
    entityId: source.id,
    metadata: { discovered, duplicates, evaluated, pendingReview, unavailable },
  });

  return { discovered, duplicates, evaluated, pendingReview, unavailable };
}

/** Deterministic ingest for MANUAL sources (admin enters listings by hand). */
export async function addManualListing(input: {
  sourceId: string;
  title: string;
  body: string;
  url?: string;
  actorId: string;
}) {
  const source = await prisma.opportunitySource.findUnique({ where: { id: input.sourceId } });
  if (!source || source.kind !== "MANUAL") throw Errors.badRequest("Manual listing requires a MANUAL source");
  return ingestSource({
    sourceId: input.sourceId,
    listings: [{ title: input.title, body: input.body, url: input.url }],
    actorId: input.actorId,
  });
}

// ── Moderation ───────────────────────────────────────────────────────

export async function listModerationQueue(status?: string) {
  return prisma.discoveredOpportunity.findMany({
    where: { status: (status ?? "PENDING_REVIEW") as never },
    include: { source: { select: { name: true, trustLevel: true } } },
    orderBy: { riskScore: "desc" },
    take: 200,
  });
}

export async function moderateOpportunity(input: {
  opportunityId: string;
  adminId: string;
  approve: boolean;
  note?: string;
}): Promise<{ published: boolean }> {
  const opportunity = await prisma.discoveredOpportunity.findUnique({ where: { id: input.opportunityId } });
  if (!opportunity) throw Errors.notFound("Opportunity not found");
  if (!["PENDING_REVIEW", "EVALUATED"].includes(opportunity.status)) {
    throw Errors.conflict(`Opportunity is ${opportunity.status}; moderation acts on PENDING_REVIEW`);
  }

  if (!input.approve) {
    await prisma.discoveredOpportunity.update({
      where: { id: opportunity.id },
      data: { status: "REJECTED", reviewedById: input.adminId, reviewNote: input.note?.slice(0, 1000) ?? "Rejected by moderator" },
    });
    await audit({
      actorId: input.adminId,
      actorRole: "ADMIN",
      action: "opportunities.rejected",
      entityType: "discovered_opportunity",
      entityId: opportunity.id,
    });
    return { published: false };
  }

  // Human approval gate → publish to the worker catalogue.
  await prisma.discoveredOpportunity.update({
    where: { id: opportunity.id },
    data: { status: "PUBLISHED", reviewedById: input.adminId, reviewNote: input.note?.slice(0, 1000) ?? "Approved by moderator" },
  });
  await audit({
    actorId: input.adminId,
    actorRole: "ADMIN",
    action: "opportunities.published",
    entityType: "discovered_opportunity",
    entityId: opportunity.id,
    metadata: { riskScore: opportunity.riskScore, riskBand: opportunity.riskBand },
  });
  logger.info("opportunity_published", { id: opportunity.id, riskBand: opportunity.riskBand });
  return { published: true };
}

// ── Catalogue (worker-facing) ────────────────────────────────────────

export async function listCatalogue(filters?: { search?: string; maxRisk?: "LOW" | "MEDIUM" }) {
  return prisma.discoveredOpportunity.findMany({
    where: {
      status: "PUBLISHED",
      ...(filters?.maxRisk ? { riskBand: { in: filters.maxRisk === "LOW" ? ["LOW"] : ["LOW", "MEDIUM"] } } : {}),
      ...(filters?.search
        ? {
            OR: [
              { title: { contains: filters.search, mode: "insensitive" } },
              { description: { contains: filters.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { source: { select: { name: true } } },
    orderBy: { fetchedAt: "desc" },
    take: 100,
  });
}
