import "server-only";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { recordAiUsage } from "./systemHealth";
import { safeFetchText } from "./safeFetch";

// CRM-native competitor monitoring. Fetch a public page, normalise to visible
// text, hash it, and only when the hash changes do we snapshot, diff, apply
// cheap keyword rules, and (for material changes only) ask the LLM to classify.
// Cost ladder: hash → diff → rules → LLM, so most checks cost nothing.

export type Materiality = "noise" | "minor" | "important" | "critical";

// ── Fetch safety (SSRF guard) ────────────────────────────────────────────────
function isSafeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "::1" || host === "0.0.0.0" || host === "[::1]") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

// ── Normalisation ────────────────────────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

/** Strip scripts/styles/chrome and tags → collapsed visible text + <title>. */
export function normalizeHtml(html: string): { text: string; title: string | null } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim().slice(0, 300) : null;

  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(nav|header|footer|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  // Preserve block boundaries as newlines so line-diffing is meaningful.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { text: s.slice(0, 500_000), title };
}

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ── Diff + materiality rules ─────────────────────────────────────────────────
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const a = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
  const b = new Set(after.split("\n").map((l) => l.trim()).filter(Boolean));
  return {
    added: [...b].filter((l) => !a.has(l)),
    removed: [...a].filter((l) => !b.has(l)),
  };
}

// Money, %, plan/pricing/product/availability/hiring words = worth a look.
const MATERIAL_RE =
  /(R\s?\d|[$€£]\s?\d|\d+\s?%|\bpricing?\b|\bplan(s)?\b|\bpackage|\bfree\b|\blaunch|\brelease|\bnew\b|\bwarranty|\bkm\b|\bkwh\b|\brange\b|\bbattery|\bmotor\b|\bhiring\b|\bcareers?\b|\bvacanc|\bpartnership|\bdiscount|\bsale\b|\bavailable|\bout of stock|\bcoming soon)/i;
// Obvious noise — never promote on these alone.
const NOISE_RE = /^(©|copyright|cookies?\b|privacy|terms\b|\d{4}\s+all rights|last updated)/i;

export function assessMateriality(added: string[], removed: string[]): { material: boolean; signals: string[] } {
  const changed = [...added, ...removed].filter((l) => l.length > 2 && !NOISE_RE.test(l));
  const signals = changed.filter((l) => MATERIAL_RE.test(l)).slice(0, 8);
  return { material: signals.length > 0, signals };
}

// ── LLM classification (material changes only) ───────────────────────────────
// Validated with Zod rather than hand-coerced. is_material is REQUIRED (no catch)
// so a malformed response fails closed instead of silently defaulting.
const classifySchema = z.object({
  is_material: z.boolean(),
  category: z.enum(["pricing", "product", "messaging", "hiring", "other"]).catch("other"),
  materiality: z.enum(["noise", "minor", "important", "critical"]).catch("minor"),
  summary: z.string().catch("").transform((s) => s.slice(0, 500)),
});
type ClassifyResult = z.infer<typeof classifySchema>;

async function aiClassifyChange(input: {
  competitorName: string;
  sourceLabel: string;
  before: string;
  after: string;
}): Promise<ClassifyResult | null> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        system:
          'You are a competitive-intelligence analyst for Denago, an electric-vehicle (golf cart / LSV) dealer in Cape Town. Classify ONLY the supplied before/after evidence from a competitor\'s public web page. Do not invent facts beyond the evidence. A change is material only if it may affect pricing, product capability, positioning/messaging, availability, hiring signals, or competitive risk. Respond with STRICT JSON only: {"is_material": boolean, "category": "pricing|product|messaging|hiring|other", "materiality": "noise|minor|important|critical", "summary": "one factual sentence"}',
        messages: [
          {
            role: "user",
            content: `Competitor: ${input.competitorName}\nPage: ${input.sourceLabel}\n\nREMOVED (before):\n${input.before || "(nothing)"}\n\nADDED (after):\n${input.after || "(nothing)"}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      await logError("competitor-ai", `Anthropic API ${res.status}`, (await res.text().catch(() => "")).slice(0, 300));
      return null;
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const content: string = json.content?.[0]?.text ?? "{}";
    const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      await logError("competitor-ai", "Classification returned non-JSON");
      return null;
    }
    const parsed = classifySchema.safeParse(raw);
    if (!parsed.success) {
      await logError("competitor-ai", "Classification failed schema validation", JSON.stringify(parsed.error.issues).slice(0, 300));
      return null;
    }
    return parsed.data;
  } catch (err) {
    await logError("competitor-ai", err);
    return null;
  }
}

// ── Collection ───────────────────────────────────────────────────────────────
export type CollectResult = { ok: boolean; changed: boolean; changeId?: string; error?: string };

/**
 * Fetch one source, snapshot on change, and record a classified change.
 * Wrapped in a collection lease so an overlapping manual + cron run can't
 * double-process the same source (duplicate snapshots, changes, notifications).
 * A stale lease (crashed run) auto-expires after 10 minutes.
 */
export async function collectSource(sourceId: string): Promise<CollectResult> {
  const leaseCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const claim = await prisma.competitorSource.updateMany({
    where: { id: sourceId, OR: [{ collectingAt: null }, { collectingAt: { lt: leaseCutoff } }] },
    data: { collectingAt: new Date() },
  });
  if (claim.count === 0) return { ok: true, changed: false }; // another run already holds the lease
  try {
    return await collectSourceInner(sourceId);
  } finally {
    await prisma.competitorSource
      .updateMany({ where: { id: sourceId }, data: { collectingAt: null } })
      .catch(() => {});
  }
}

async function collectSourceInner(sourceId: string): Promise<CollectResult> {
  const source = await prisma.competitorSource.findUnique({ where: { id: sourceId }, include: { competitor: true } });
  if (!source) return { ok: false, changed: false, error: "Source not found" };

  const fail = async (error: string): Promise<CollectResult> => {
    await prisma.competitorSource.update({
      where: { id: sourceId },
      data: { lastCheckedAt: new Date(), lastStatus: "error", lastError: error.slice(0, 300) },
    });
    return { ok: false, changed: false, error };
  };

  let html: string;
  try {
    // safeFetchText enforces the SSRF guard (DNS + private-IP blocking, redirect
    // re-validation, port allow-list, connect-time DNS pin) and a hard byte cap.
    const res = await safeFetchText(source.url, {
      maxBytes: 3_000_000,
      timeoutMs: 20_000,
      userAgent: "DenagoCRM-CompetitorWatch/1.0 (+https://crm.denagocpt.co.za)",
    });
    if (res.status < 200 || res.status >= 300) return fail(`HTTP ${res.status}`);
    if (res.contentType && !/text|html|xml|json/i.test(res.contentType)) {
      return fail(`Unsupported content-type: ${res.contentType.slice(0, 60)}`);
    }
    html = res.text;
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Fetch failed");
  }

  const { text, title } = normalizeHtml(html);
  if (!text) return fail("No readable content");
  const hash = hashText(text);

  // Unchanged → just record the successful check.
  if (hash === source.contentHash) {
    await prisma.competitorSource.update({
      where: { id: sourceId },
      data: { lastCheckedAt: new Date(), lastStatus: "ok", lastError: null },
    });
    return { ok: true, changed: false };
  }

  const prev = await prisma.competitorSnapshot.findFirst({ where: { sourceId }, orderBy: { fetchedAt: "desc" } });
  // Raw HTML is NOT persisted: the old path wrote it to a public Blob URL. The
  // normalised cleanText below is the diff/evidence source and lives in the DB.
  const snapshot = await prisma.competitorSnapshot.create({
    data: {
      competitorId: source.competitorId,
      sourceId,
      contentHash: hash,
      title,
      cleanText: text.slice(0, 200_000),
      rawRef: null,
      wordCount: text.split(/\s+/).filter(Boolean).length,
    },
  });
  await prisma.competitorSource.update({
    where: { id: sourceId },
    data: { lastCheckedAt: new Date(), lastChangedAt: new Date(), lastStatus: "ok", lastError: null, contentHash: hash },
  });

  // First snapshot ever = baseline, nothing to compare against.
  if (!prev) return { ok: true, changed: false };

  const { added, removed } = lineDiff(prev.cleanText, text);
  const { material, signals } = assessMateriality(added, removed);
  const evidenceAfter = added.slice(0, 12).join("\n").slice(0, 2000) || null;
  const evidenceBefore = removed.slice(0, 12).join("\n").slice(0, 2000) || null;

  const ai = material
    ? await aiClassifyChange({
        competitorName: source.competitor.name,
        sourceLabel: source.label,
        before: evidenceBefore ?? "",
        after: evidenceAfter ?? "",
      })
    : null;

  // Suppression ladder: rules found nothing → drop; the LLM explicitly judged it
  // immaterial → drop (honours is_material, not just materiality); noise → drop.
  if (!material) return { ok: true, changed: false };
  if (ai && !ai.is_material) return { ok: true, changed: false };
  const materiality: Materiality = ai?.materiality ?? "important";
  if (materiality === "noise") return { ok: true, changed: false };

  const change = await prisma.competitorChange.create({
    data: {
      competitorId: source.competitorId,
      sourceId,
      prevSnapshotId: prev.id,
      snapshotId: snapshot.id,
      status: "new",
      materiality,
      category: ai?.category ?? null,
      summary: (ai?.summary || signals[0] || "Content changed on this page").slice(0, 500),
      evidenceBefore,
      evidenceAfter,
      aiJson: ai ? (ai as object) : undefined,
    },
  });

  if (materiality === "critical" || materiality === "important") {
    try {
      const { sendPushToAll } = await import("./push");
      await sendPushToAll(
        {
          title: `Competitor: ${source.competitor.name}`,
          body: (ai?.summary || "Material change detected").slice(0, 120),
          url: `/competitors/${source.competitorId}`,
        },
        "competitor",
      );
    } catch {
      /* push is best-effort */
    }
  }

  return { ok: true, changed: true, changeId: change.id };
}

// Social profiles are discovered and covered by the AI research brief — plain
// HTML diffing behind login walls is unreliable, so they stay out of the cheap
// daily page-diff worklist.
export const SOCIAL_TYPES = ["facebook", "instagram", "linkedin", "youtube", "x", "tiktok"];
export const DISCOVERABLE_TYPES = [
  "page", "pricing", "product", "news", "blog", ...SOCIAL_TYPES,
];

/** Active, non-social sources not checked in ~20h — the daily watch worklist. */
export async function dueSourceIds(limit = 25): Promise<string[]> {
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000);
  const sources = await prisma.competitorSource.findMany({
    where: {
      active: true,
      sourceType: { notIn: SOCIAL_TYPES },
      competitor: { status: "active", deletedAt: null },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: cutoff } }],
    },
    orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }],
    take: limit,
    select: { id: true },
  });
  return sources.map((s) => s.id);
}

export async function pendingChangeCount(): Promise<number> {
  return prisma.competitorChange.count({ where: { status: "new" } });
}

// ── AI research layer (strong model + web search) ────────────────────────────
// The intelligence half of the module. A strong model discovers a competitor's
// footprint once and produces periodic deep-research briefs; the cheap daily
// diff (above) fills the gaps between briefs. Cost ladder: Sonnet+search for
// discovery/weekly briefs, Haiku for day-to-day change classification.

const RESEARCH_MODEL = "claude-sonnet-5";

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return (url.hostname + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

type WebSearchOut = { text: string; citations: Array<{ title: string; url: string }> };

/** One Anthropic call with the server-side web_search tool enabled. */
async function callWithWebSearch(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  maxUses?: number;
  timeoutMs?: number;
}): Promise<WebSearchOut | { error: string }> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return { error: "AI Assist is not configured (Settings → Integrations)." };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: RESEARCH_MODEL,
        max_tokens: opts.maxTokens ?? 1500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxUses ?? 6 }],
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      }),
    });
    if (!res.ok) {
      await logError("competitor-ai", `Anthropic API ${res.status}`, (await res.text().catch(() => "")).slice(0, 300));
      return { error: `AI request failed (${res.status}).` };
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const blocks: Array<Record<string, unknown>> = Array.isArray(json.content) ? json.content : [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("\n")
      .trim();
    const citations = new Map<string, { title: string; url: string }>();
    for (const b of blocks) {
      const cites = (b as { citations?: Array<{ url?: string; title?: string }> }).citations;
      if (b.type === "text" && Array.isArray(cites)) {
        for (const c of cites) if (c.url) citations.set(c.url, { title: c.title ?? c.url, url: c.url });
      }
    }
    return { text, citations: [...citations.values()].slice(0, 20) };
  } catch (err) {
    await logError("competitor-ai", err);
    return { error: "AI request failed — logged in the System Log." };
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export type DiscoverResult = { ok: boolean; created: number; skipped: number; error?: string; briefId?: string };

/** Strong model + web search: find the competitor's real footprint (site pages
 *  + social profiles) and auto-create the sources to watch. Run once / on demand. */
export async function discoverSources(competitorId: string, createdById?: string | null): Promise<DiscoverResult> {
  const competitor = await prisma.competitor.findUnique({ where: { id: competitorId } });
  if (!competitor) return { ok: false, created: 0, skipped: 0, error: "Competitor not found" };

  const system = `You are a competitive-intelligence researcher for Denago, an electric-vehicle (golf cart / low-speed vehicle) dealer in Cape Town, South Africa. Given a competitor company, use web search to find its real online footprint. Identify:
- the official website and the specific pages worth monitoring for competitive change (home, pricing, product/models, news/blog, promotions)
- its public social profiles (Facebook, Instagram, LinkedIn, YouTube, X/Twitter, TikTok)
Only include URLs you actually found and verified via search — never guess or fabricate URLs. Prefer canonical, stable URLs.
After searching, respond with STRICT JSON ONLY (no prose, no code fences) in exactly this shape:
{"website":"https://...","description":"one factual sentence about the company","sources":[{"label":"Pricing","url":"https://...","sourceType":"pricing"}]}
sourceType must be one of: page, pricing, product, news, blog, facebook, instagram, linkedin, youtube, x, tiktok. Include 4-10 sources. If you cannot confidently identify the company, return {"website":null,"description":null,"sources":[]}.`;

  const user = `Competitor: ${competitor.name}${competitor.website ? `\nKnown website: ${competitor.website}` : ""}\nRegion focus: South Africa (also include the official global pages).`;

  const result = await callWithWebSearch({ system, user, maxTokens: 2000, maxUses: 8, timeoutMs: 90000 });
  if ("error" in result) return { ok: false, created: 0, skipped: 0, error: result.error };

  const parsed = extractJson(result.text);
  const proposed = Array.isArray(parsed?.sources) ? (parsed!.sources as Array<Record<string, unknown>>) : null;
  if (!proposed) return { ok: false, created: 0, skipped: 0, error: "Discovery returned no usable sources." };

  const existing = await prisma.competitorSource.findMany({ where: { competitorId }, select: { url: true } });
  const seen = new Set(existing.map((s) => normalizeUrl(s.url)));
  const allowed = new Set(DISCOVERABLE_TYPES);

  let created = 0;
  let skipped = 0;
  for (const raw of proposed.slice(0, 12)) {
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    const label = typeof raw?.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 120) : "Page";
    const sourceType = typeof raw?.sourceType === "string" && allowed.has(raw.sourceType) ? raw.sourceType : "page";
    if (!url || !isSafeUrl(url) || seen.has(normalizeUrl(url))) {
      skipped++;
      continue;
    }
    seen.add(normalizeUrl(url));
    await prisma.competitorSource.create({ data: { competitorId, label, url, sourceType, active: true } });
    created++;
  }

  const patch: Record<string, unknown> = {};
  if (!competitor.website && typeof parsed?.website === "string" && isSafeUrl(parsed.website)) {
    patch.website = parsed.website.slice(0, 500);
  }
  if (!competitor.description && typeof parsed?.description === "string" && parsed.description.trim()) {
    patch.description = parsed.description.trim().slice(0, 1000);
  }
  if (Object.keys(patch).length) await prisma.competitor.update({ where: { id: competitorId }, data: patch });

  const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
  const brief = await prisma.competitorBrief.create({
    data: {
      competitorId,
      kind: "discovery",
      headline: `Discovered ${created} source${created === 1 ? "" : "s"} to watch`,
      body: `${description ? `${description}\n\n` : ""}Added ${created} monitored source(s); skipped ${skipped} (duplicate/unusable).`,
      citations: result.citations.length ? result.citations : undefined,
      model: RESEARCH_MODEL,
      createdById: createdById ?? undefined,
    },
  });

  return { ok: true, created, skipped, briefId: brief.id };
}

export type ResearchResult = { ok: boolean; briefId?: string; error?: string };

/** Strong model + web search: write a fresh intelligence brief, cross-checked
 *  against our own recently-detected page changes. Weekly / on demand. */
export async function researchCompetitor(competitorId: string, createdById?: string | null): Promise<ResearchResult> {
  const competitor = await prisma.competitor.findUnique({
    where: { id: competitorId },
    include: { sources: { where: { active: true }, select: { label: true, url: true, sourceType: true } } },
  });
  if (!competitor) return { ok: false, error: "Competitor not found" };

  const recentChanges = await prisma.competitorChange.findMany({
    where: { competitorId },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { summary: true, category: true, materiality: true },
  });

  const sourceList =
    competitor.sources.map((s) => `- ${s.label} (${s.sourceType}): ${s.url}`).join("\n") || "(none yet)";
  const changeList =
    recentChanges.map((c) => `- [${c.materiality}/${c.category ?? "?"}] ${c.summary}`).join("\n") || "(none)";

  const system = `You are a competitive-intelligence analyst for Denago, an electric golf-cart / low-speed-vehicle dealer in Cape Town, South Africa. Produce a concise, factual intelligence brief on the named competitor using web search. Focus on what a sales and leadership team needs: current product line-up and any new models, pricing and current promotions, positioning and messaging, expansion / new locations / partnerships, hiring signals, and anything that shifts the competitive threat to Denago. Cross-check against the recently auto-detected page changes supplied. Never fabricate — if something is unknown, say so in one line.
Format as plain text, short lines, no preamble:
HEADLINE: <8-14 word summary of the single most important current development>
Then 4-8 bullet points ("- ..."), each a factual finding.
End with one line: "So what for Denago: <implication>".`;

  const user = `Competitor: ${competitor.name}${competitor.website ? ` — ${competitor.website}` : ""}
Monitored sources:
${sourceList}

Recently auto-detected page changes (from our own monitoring):
${changeList}

Write the current intelligence brief.`;

  const result = await callWithWebSearch({ system, user, maxTokens: 1800, maxUses: 8, timeoutMs: 90000 });
  if ("error" in result) return { ok: false, error: result.error };
  if (!result.text) return { ok: false, error: "No usable research came back." };

  const headlineMatch = result.text.match(/HEADLINE:\s*(.+)/i);
  const headline = headlineMatch ? headlineMatch[1].trim().slice(0, 200) : null;
  const body = result.text.replace(/^\s*HEADLINE:\s*.+\n?/i, "").trim().slice(0, 8000);

  const brief = await prisma.competitorBrief.create({
    data: {
      competitorId,
      kind: "research",
      headline,
      body,
      citations: result.citations.length ? result.citations : undefined,
      model: RESEARCH_MODEL,
      createdById: createdById ?? undefined,
    },
  });
  await prisma.competitor.update({ where: { id: competitorId }, data: { lastResearchedAt: new Date() } });

  try {
    const { sendPushToAll } = await import("./push");
    await sendPushToAll(
      { title: `Intel: ${competitor.name}`, body: headline ?? "New competitor brief", url: `/competitors/${competitorId}` },
      "competitor",
    );
  } catch {
    /* push is best-effort */
  }

  return { ok: true, briefId: brief.id };
}

/** Active competitors whose weekly deep-research pass is due. */
export async function competitorsDueForResearch(limit = 2): Promise<string[]> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.competitor.findMany({
    where: {
      status: "active",
      deletedAt: null,
      OR: [{ lastResearchedAt: null }, { lastResearchedAt: { lt: cutoff } }],
    },
    orderBy: [{ lastResearchedAt: { sort: "asc", nulls: "first" } }],
    take: limit,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Active competitors that have no sources yet — candidates for auto-discovery. */
export async function competitorsNeedingDiscovery(limit = 2): Promise<string[]> {
  const rows = await prisma.competitor.findMany({
    where: { status: "active", deletedAt: null, sources: { none: {} } },
    take: limit,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
