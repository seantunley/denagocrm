export type BuilderRecordKind = "quote" | "jobcard";

const QUOTE_KEYS = new Set([
  "quote",
  "invoice",
  "agreement",
  "delivery",
  "indemnity",
]);

const JOB_CARD_KEYS = new Set([
  "jobcard",
  "service-report",
  "warranty-claim",
]);

export function requiredRecordKind(
  templateKey: string,
): BuilderRecordKind | "either" | null {
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
  if ((kind !== "quote" && kind !== "jobcard") || !id) return null;
  return { kind, id };
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
} {
  const parsed = parseBuilderRecord(record);
  if (!parsed) return {};
  return parsed.kind === "quote"
    ? { quoteId: parsed.id }
    : { jobCardId: parsed.id };
}
