import "server-only";
import crypto from "crypto";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { recordAiUsage } from "./systemHealth";
import { saveFile } from "./storage";

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
type ClassifyResult = { is_material: boolean; category: string; materiality: Materiality; summary: string };

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
    const match = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : "{}");
    const materiality: Materiality = ["noise", "minor", "important", "critical"].includes(parsed.materiality)
      ? parsed.materiality
      : "minor";
    return {
      is_material: Boolean(parsed.is_material),
      category: String(parsed.category ?? "other").slice(0, 40),
      materiality,
      summary: String(parsed.summary ?? "").slice(0, 500),
    };
  } catch (err) {
    await logError("competitor-ai", err);
    return null;
  }
}

// ── Collection ───────────────────────────────────────────────────────────────
export type CollectResult = { ok: boolean; changed: boolean; changeId?: string; error?: string };

/** Fetch one source, snapshot on change, and record a classified change. */
export async function collectSource(sourceId: string): Promise<CollectResult> {
  const source = await prisma.competitorSource.findUnique({ where: { id: sourceId }, include: { competitor: true } });
  if (!source) return { ok: false, changed: false, error: "Source not found" };

  const fail = async (error: string): Promise<CollectResult> => {
    await prisma.competitorSource.update({
      where: { id: sourceId },
      data: { lastCheckedAt: new Date(), lastStatus: "error", lastError: error.slice(0, 300) },
    });
    return { ok: false, changed: false, error };
  };

  if (!isSafeUrl(source.url)) return fail("Unsafe or invalid URL");

  let html: string;
  try {
    const res = await fetch(source.url, {
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
      headers: { "User-Agent": "DenagoCRM-CompetitorWatch/1.0 (+https://crm.denagocpt.co.za)" },
    });
    if (!res.ok) return fail(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/text|html|xml|json/i.test(ct)) return fail(`Unsupported content-type: ${ct.slice(0, 60)}`);
    html = (await res.text()).slice(0, 3_000_000);
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
  const rawRef = await saveFile(Buffer.from(html, "utf8"), "competitor-snapshot.html", "text/html").catch(() => null);
  const snapshot = await prisma.competitorSnapshot.create({
    data: {
      competitorId: source.competitorId,
      sourceId,
      contentHash: hash,
      title,
      cleanText: text.slice(0, 200_000),
      rawRef,
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

  const materiality: Materiality = ai?.materiality ?? (material ? "important" : "minor");
  // Rules found nothing and (if consulted) the LLM called it noise → drop it.
  if (!material || materiality === "noise") return { ok: true, changed: false };

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

/** Active sources not checked in ~20h — the daily watch worklist. */
export async function dueSourceIds(limit = 25): Promise<string[]> {
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000);
  const sources = await prisma.competitorSource.findMany({
    where: {
      active: true,
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
