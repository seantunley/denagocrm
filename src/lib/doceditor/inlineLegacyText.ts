/**
 * Moves the invoice's and sales agreement's owner-written text — banking
 * details, payment terms, clauses, intro line — out of the old form editor and
 * INTO the layout, as ordinary text the owner edits where it prints.
 *
 * Until now those layouts held tokens ({{invoice.bankingDetails}} …) filled
 * from the old editor at print time, so formatting an invoice meant the
 * document editor and setting the bank details meant a second screen. Sean
 * asked, more than once, for one place (2026-10-07).
 *
 * Each token's conditional block becomes its contents with the text written in.
 * A section switched off, or left empty, in the old editor stays out — exactly
 * what printed before; the owner adds a box in the editor to bring one back.
 * Pure: the caller saves.
 */

export type LegacySection = { text: string; on: boolean };
export type LegacyText = Record<string, LegacySection>;

/** The tokens each document's standard layout read from the old editor. */
export const LEGACY_FIELDS: Record<"invoice" | "agreement", string[]> = {
  invoice: ["intro", "paymentTerms", "bankingDetails"],
  agreement: ["intro", "clauses"],
};

type Json = unknown;

export function hasLegacyTokens(key: string, data: Json): boolean {
  if (key !== "invoice" && key !== "agreement") return false;
  const raw = JSON.stringify(data ?? null);
  return LEGACY_FIELDS[key].some((field) => raw.includes(`${key}.${field}`));
}

export function inlineLegacyText(key: "invoice" | "agreement", data: Json, legacy: LegacyText): Json {
  const fields = LEGACY_FIELDS[key];
  // The text, or null when the section is off or empty (it stays out).
  const value = (field: string): string | null => {
    const section = legacy[field];
    return section?.on && section.text.trim() ? section.text.trim() : null;
  };
  const fill = (s: string) =>
    s.replace(new RegExp(`\\{\\{\\s*${key}\\.(\\w+)\\s*\\}\\}`, "g"), (all, field: string) => (fields.includes(field) ? value(field) ?? "" : all));

  const walk = (node: Json): Json => {
    if (typeof node === "string") return fill(node);
    if (Array.isArray(node)) {
      return node.flatMap((item) => {
        const block = item as { type?: unknown; when?: unknown; blocks?: unknown };
        const when = typeof block?.when === "string" ? block.when : "";
        if (block?.type === "conditional" && when.startsWith(`${key}.`) && fields.includes(when.slice(key.length + 1))) {
          // The section's own wrapper: unwrap it, or drop it with nothing to say.
          if (value(when.slice(key.length + 1)) === null) return [];
          return (walk(block.blocks ?? []) as Json[]);
        }
        return [walk(item)];
      });
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(data);
}
