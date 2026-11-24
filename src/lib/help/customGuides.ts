import type { HelpBlock, HelpCategoryKey } from "./types";
import { HELP_CATEGORIES } from "./categories";

/**
 * A workspace's OWN help guides (2026-11-23) — "How we handle trade-ins",
 * "Our delivery checklist" — written by the owner and shown beside the built-in
 * ones. Pure: the shape, the limits, and how plain text becomes an article.
 *
 * KEPT AS ONE SETTING (HELP_CUSTOM_GUIDES, a JSON list) rather than a table:
 * a workspace has a handful of these, the owner alone edits them, and it
 * needed no migration. The limits below keep that setting small; if guides ever
 * need drafts, history or more than a few dozen, that is the day for a table.
 *
 * WRITTEN AS PLAIN TEXT with five marks, so nobody has to learn an editor and
 * nothing a person types is ever treated as HTML:
 *   # Heading          - bullet          1. numbered step
 *   > a tip in a box   **bold** inside any line
 * A blank line ends a paragraph or a list.
 */
export const CUSTOM_GUIDES_KEY = "HELP_CUSTOM_GUIDES";
export const MAX_GUIDES = 40;
export const MAX_TITLE = 100;
export const MAX_SUMMARY = 200;
export const MAX_BODY = 12_000;

export type CustomGuide = {
  id: string;
  title: string;
  summary: string;
  area: HelpCategoryKey;
  body: string;
  /** ISO time of the last save, and who saved it. */
  updatedAt: string;
  updatedBy: string;
};

const ID = /^[a-z0-9]{8,40}$/;
const AREAS = new Set<string>(HELP_CATEGORIES.map((category) => category.key));
export const isGuideId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
export const isHelpArea = (value: unknown): value is HelpCategoryKey => typeof value === "string" && AREAS.has(value);

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  // Control characters out (tabs and new lines stay); Windows line ends become plain ones.
  const clean = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return clean.length > 0 && clean.length <= max ? clean : null;
};

/** The stored setting as guides. A damaged entry is dropped; a damaged setting reads as none. */
export function parseGuides(raw: string | null | undefined): CustomGuide[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const guides: CustomGuide[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = text(row.title, MAX_TITLE);
    const body = text(row.body, MAX_BODY);
    if (!isGuideId(row.id) || seen.has(row.id) || !title || !body || !isHelpArea(row.area)) continue;
    seen.add(row.id);
    guides.push({
      id: row.id,
      title,
      summary: text(row.summary, MAX_SUMMARY) ?? "",
      area: row.area,
      body,
      updatedAt: typeof row.updatedAt === "string" && !Number.isNaN(Date.parse(row.updatedAt)) ? row.updatedAt : new Date(0).toISOString(),
      updatedBy: text(row.updatedBy, 120) ?? "",
    });
    if (guides.length === MAX_GUIDES) break;
  }
  return guides;
}

export type GuideInput = { title: string; summary: string; area: HelpCategoryKey; body: string };
export type GuideInputResult = { ok: true; input: GuideInput } | { ok: false; error: string };

/** What the owner typed, checked. The message is for the owner, so it says what to change. */
export function readGuideInput(fields: { title: unknown; summary: unknown; area: unknown; body: unknown }): GuideInputResult {
  const title = text(fields.title, MAX_TITLE);
  if (!title) return { ok: false, error: `Give the guide a title of up to ${MAX_TITLE} characters.` };
  const rawSummary = typeof fields.summary === "string" ? fields.summary.trim() : "";
  const summary = rawSummary ? text(rawSummary.replace(/\s+/g, " "), MAX_SUMMARY) : "";
  if (summary === null) return { ok: false, error: `Keep the one-line summary under ${MAX_SUMMARY} characters.` };
  if (!isHelpArea(fields.area)) return { ok: false, error: "Choose which area the guide belongs to." };
  const body = text(fields.body, MAX_BODY);
  if (!body) return { ok: false, error: `Write the guide itself — up to ${MAX_BODY.toLocaleString("en-ZA")} characters.` };
  return { ok: true, input: { title: title.replace(/\s+/g, " "), summary, area: fields.area, body } };
}

export type GuideChange = { ok: true; guides: CustomGuide[] } | { ok: false; error: string };

/** The list with this guide added (no `id`) or replaced (an `id` that exists). Newest edit first. */
export function saveGuide(guides: readonly CustomGuide[], input: GuideInput, meta: { id: string; existing: boolean; at: string; by: string }): GuideChange {
  if (!isGuideId(meta.id)) return { ok: false, error: "That guide can't be saved — reload the page and try again." };
  const found = guides.some((guide) => guide.id === meta.id);
  if (meta.existing && !found) return { ok: false, error: "That guide has been deleted. Reload the page." };
  if (!meta.existing && found) return { ok: false, error: "That guide can't be saved — reload the page and try again." };
  if (!meta.existing && guides.length >= MAX_GUIDES) return { ok: false, error: `A workspace can have up to ${MAX_GUIDES} of its own guides. Delete one you no longer need first.` };
  const guide: CustomGuide = { id: meta.id, ...input, updatedAt: meta.at, updatedBy: meta.by };
  return { ok: true, guides: [guide, ...guides.filter((other) => other.id !== meta.id)] };
}

export const removeGuide = (guides: readonly CustomGuide[], id: string): CustomGuide[] => guides.filter((guide) => guide.id !== id);

/**
 * The plain text as article blocks (the marks are listed at the top of this
 * file). Everything stays TEXT: the article renderer prints it and honours
 * **bold**, so a guide can never carry markup or a script.
 */
export function guideBlocks(body: string): HelpBlock[] {
  const blocks: HelpBlock[] = [];
  let paragraph: string[] = [];
  let list: { type: "list" | "steps"; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
    if (list) blocks.push(list);
    paragraph = [];
    list = null;
  };
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    const step = /^\d{1,2}[.)]\s+(.+)$/.exec(line);
    const tip = /^>\s*(.+)$/.exec(line);
    if (heading) { flush(); blocks.push({ type: "h", text: heading[1] }); continue; }
    if (tip) { flush(); blocks.push({ type: "callout", tone: "tip", text: tip[1] }); continue; }
    if (bullet || step) {
      const type = bullet ? "list" : "steps";
      if (paragraph.length || (list && list.type !== type)) flush();
      list ??= { type, items: [] };
      list.items.push((bullet ?? step)![1]);
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}
