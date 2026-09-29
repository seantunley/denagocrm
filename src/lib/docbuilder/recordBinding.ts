export type BuilderRecordKind = "quote" | "jobcard" | "lead" | "warranty";

const QUOTE_KEYS = new Set([
  "quote",
  "invoice",
  "agreement",
  "delivery",
]);

const JOB_CARD_KEYS = new Set([
  "jobcard",
  "service-report",
]);

// The indemnity is signed before a test drive — there is no quote yet, only the
// lead — and the warranty claim prints a WarrantyClaim, not a job card.
const OWN_RECORD_KEYS = new Map<string, BuilderRecordKind>([
  ["indemnity", "lead"],
  ["warranty-claim", "warranty"],
]);

export function requiredRecordKind(
  templateKey: string,
): BuilderRecordKind | "either" | null {
  const own = OWN_RECORD_KEYS.get(templateKey);
  if (own) return own;
  if (QUOTE_KEYS.has(templateKey)) return "quote";
  if (JOB_CARD_KEYS.has(templateKey)) return "jobcard";
  if (["proposal", "custom"].includes(templateKey)) return "either";
  return null;
}

export function parseBuilderRecord(value: string | null | undefined): {
  kind: BuilderRecordKind;
  id: string;
} | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator < 1) return null;
  const kind = trimmed.slice(0, separator);
  const id = trimmed.slice(separator + 1).trim();
  if (!["quote", "jobcard", "lead", "warranty"].includes(kind) || !id) return null;
  return { kind: kind as BuilderRecordKind, id };
}

export function recordMatchesTemplate(
  templateKey: string,
  kind: BuilderRecordKind,
): boolean {
  const required = requiredRecordKind(templateKey);
  return required === "either" || required === kind;
}

export function bindingParams(record: string | null | undefined): {
  quoteId?: string;
  jobCardId?: string;
  leadId?: string;
  warrantyClaimId?: string;
} {
  const parsed = parseBuilderRecord(record);
  if (!parsed) return {};
  if (parsed.kind === "lead") return { leadId: parsed.id };
  if (parsed.kind === "warranty") return { warrantyClaimId: parsed.id };
  return parsed.kind === "quote"
    ? { quoteId: parsed.id }
    : { jobCardId: parsed.id };
}
