import { pageSizeOf, type DocumentBlock, type DocumentModel, type OverlayField } from "./model";
import { VARIABLES } from "./variables";
import { MIN_RUNNING_MARGIN } from "./pageFurniture";

/**
 * A design check: things in a layout that will look wrong, or go wrong for a
 * signer, found by reading the document — before a customer finds them.
 *
 * It WARNS. It never blocks a save or a publish and never changes the
 * document: every finding here can be a deliberate choice, and a check that
 * could stop a quote going out would be worse than the flaws it finds. Each
 * finding names its page, and the block or field where there is one, so the
 * editor can take the person straight to it.
 *
 * What it can see is geometry and content. What it cannot see without drawing
 * the page — whether text overflows its box, how many sheets a page prints on —
 * the editor measures and passes in as `measured`.
 *
 * Not checked, and said so rather than faked: image resolution (the stored
 * file's pixel size is not recorded) and colour contrast.
 */

export type DesignWarning = {
  code:
    | "fields-overlap" | "field-off-page" | "field-unassigned" | "float-off-page"
    | "unknown-variable" | "empty-page" | "tiny-text" | "image-missing" | "page-overflows" | "field-on-overflow" | "running-no-margin";
  message: string;
  /** 1-based, as the editor labels pages. */
  page: number;
  blockId?: string;
  fieldId?: string;
};

export type Measured = { /** How many sheets each page's content prints on, by page id (from the editor page). */ sheets?: Record<string, number> };

const KNOWN = new Set([...VARIABLES.flatMap((g) => g.fields), "items", "total", "vehicle", "preparedBy", "technician"]);
/**
 * The FAMILIES of variable some renderer fills (the picker lists only the
 * common ones; the standard layouts use many more — {{agreement.clauses}},
 * {{service.nextDue}}). A variable in a known family is not second-guessed:
 * saying "this cannot be filled" about one that can would be worse than
 * missing a typo inside a family. What this catches is a family nothing
 * fills — {{custmer.name}}, {{price}}.
 */
const KNOWN_PREFIX = /^(asset|company|quote|jobcard|customer|lead|vehicle|delivery|service|invoice|agreement|claim|warranty|indemnity|testdrive|signer|recipient|fleet|billto|message|email|date|user|booking|handover|checklist)\./;
const TOKEN = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;
const FIELD_LABEL: Record<string, string> = { signature: "signature", initials: "initials", date: "date", text: "text", checkbox: "checkbox", radio: "radio", dropdown: "dropdown", attachment: "attachment", stamp: "stamp" };

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, out));
  return out;
}

const rect = (f: OverlayField) => ({ x: f.anchor.x, y: f.anchor.y, w: f.width, h: f.height });
/** The share (0–1) of the smaller rectangle that the two have in common. */
function overlap(a: ReturnType<typeof rect>, b: ReturnType<typeof rect>): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.w * a.h, b.w * b.h);
}

const blocksOf = (block: DocumentBlock): DocumentBlock[] => (block.type === "conditional" ? [block, ...block.blocks.flatMap(blocksOf)] : [block]);

export function designWarnings(doc: DocumentModel, measured: Measured = {}): DesignWarning[] {
  const out: DesignWarning[] = [];
  // An email is one card laid out by the frame and the mail client: pages, sheets and signing fields do not apply.
  if (doc.style.pageSize === "Email") return out;
  const size = pageSizeOf(doc.style);

  doc.pages.forEach((page, index) => {
    const n = index + 1;
    const fields = page.overlayFields.filter((f) => f.anchor.mode === "page");
    const flowed = page.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks)).flatMap(blocksOf);
    const floated = page.floatingBlocks.flatMap((fb) => blocksOf(fb.block));
    const sheets = Math.max(1, measured.sheets?.[page.id] ?? 1);

    if (doc.pages.length > 1 && flowed.length === 0 && floated.length === 0 && fields.length === 0) {
      out.push({ code: "empty-page", page: n, message: `Page ${n} is empty — it will print as a blank sheet.` });
    }
    if (sheets > 1) {
      out.push({ code: "page-overflows", page: n, message: `Page ${n} has more on it than fits: it prints on ${sheets} sheets. Anything placed by hand on it (a signature, a footer band) stays on the first.` });
    }

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const r = rect(f);
      const name = `The ${FIELD_LABEL[f.kind] ?? f.kind} field${f.label ? ` “${f.label}”` : ""} on page ${n}`;
      if (r.x < 0 || r.y < 0 || r.x + r.w > size.w || r.y + r.h > size.h * sheets) {
        out.push({ code: "field-off-page", page: n, fieldId: f.id, message: `${name} runs off the edge of the sheet — part of it cannot be signed or will not print.` });
      } else if (sheets > 1 && r.y + r.h > size.h) {
        out.push({ code: "field-on-overflow", page: n, fieldId: f.id, message: `${name} sits below the first sheet's edge, so it lands on the overflow sheet.` });
      }
      if (f.recipientId === null) {
        out.push({ code: "field-unassigned", page: n, fieldId: f.id, message: `${name} is not assigned to anyone — nobody will be asked to fill it.` });
      }
      for (let j = i + 1; j < fields.length; j++) {
        if (overlap(r, rect(fields[j])) > 0.2) {
          out.push({ code: "fields-overlap", page: n, fieldId: f.id, message: `Two signing fields overlap on page ${n} (${FIELD_LABEL[f.kind] ?? f.kind} and ${FIELD_LABEL[fields[j].kind] ?? fields[j].kind}) — a signer can only reach the one on top.` });
        }
      }
    }

    for (const fb of page.floatingBlocks) {
      if (fb.x < 0 || fb.y < 0 || fb.x + fb.width > size.w + 0.5) {
        out.push({ code: "float-off-page", page: n, blockId: fb.block.id, message: `A freely placed ${fb.block.type} block on page ${n} runs off the edge of the sheet and will be cut off in print.` });
      }
    }

    for (const block of [...flowed, ...floated]) {
      if (block.hidden) continue;
      const scale = block.settings?.fontScale;
      if (scale !== undefined && scale < 0.75) {
        out.push({ code: "tiny-text", page: n, blockId: block.id, message: `Text in a ${block.type} block on page ${n} is set to ${Math.round(scale * 100)}% — small enough to be hard to read in print.` });
      }
      if (block.type === "image" && !String(block.src ?? "").trim()) {
        out.push({ code: "image-missing", page: n, blockId: block.id, message: `An image block on page ${n} has no picture — it prints as nothing.` });
      }
      // Everything a person typed into this block, looked through for {{variables}} no renderer fills.
      const { id: _id, settings: _settings, ...content } = block as Record<string, unknown>;
      void _id; void _settings;
      const unknown = new Set<string>();
      for (const text of strings(block.type === "conditional" ? { condition: (block as { condition?: unknown }).condition } : content)) {
        for (const match of text.matchAll(TOKEN)) if (!KNOWN.has(match[1]) && !KNOWN_PREFIX.test(match[1])) unknown.add(match[1]);
      }
      for (const key of unknown) {
        out.push({ code: "unknown-variable", page: n, blockId: block.id, message: `{{${key}}} on page ${n} is not a kind of variable any document fills — check the spelling, or it will print as it is typed.` });
      }
    }
  });

  // A running header or footer is set in the page margin: with too little margin it has nowhere to print.
  const lines = doc.running ? [doc.running.header, doc.running.footer] : [];
  if (doc.style.margin < MIN_RUNNING_MARGIN && lines.some((line) => Object.values(line).some((text) => text.trim()))) {
    out.push({ code: "running-no-margin", page: 1, message: `The header and footer on every page are set in the page margin, and this document's margin is ${doc.style.margin}px — they need at least ${MIN_RUNNING_MARGIN}px, so they will not print.` });
  }
  return out;
}

/** One line for a banner or a publish notice: "3 things to check: 2 on page 1, 1 on page 2". */
export function summariseWarnings(warnings: DesignWarning[]): string {
  if (warnings.length === 0) return "";
  const byPage = new Map<number, number>();
  for (const w of warnings) byPage.set(w.page, (byPage.get(w.page) ?? 0) + 1);
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, count]) => `${count} on page ${page}`).join(", ");
  return `${warnings.length} thing${warnings.length === 1 ? "" : "s"} to check: ${pages}`;
}
