/**
 * Whether a signing field's current value counts as filled. A checkbox only
 * counts once actually checked ("true") — it always submits a non-empty
 * string ("false" when unchecked), so a generic non-empty check would treat
 * an unchecked checkbox as complete. Shared by the signer UI and the signing
 * API so client and server validation can't drift apart on what "required"
 * means for a given field kind.
 */
export function isFieldValueComplete(kind: string, value: string | null | undefined): boolean {
  if (kind === "checkbox") return value === "true";
  return typeof value === "string" && value.trim() !== "";
}

export interface FillableField {
  id: string;
  kind: string;
  required: boolean;
}

/**
 * Required-field validation PER RECIPIENT. A required field is satisfied for the
 * signing recipient only if THIS submission carries a complete (kind-aware) value
 * for it, or this recipient has already recorded their own durable response to it
 * (a re-submit). Deliberately does NOT treat a globally-filled `SignatureField`
 * as satisfied: on a SHARED field (fillable by anyone) the first signer's value
 * must not let a later signer skip their own acknowledgement — that is the whole
 * point of one response per recipient.
 */
export function missingRequiredForRecipient(
  fillable: FillableField[],
  submittedValueById: ReadonlyMap<string, string | null | undefined>,
  priorResponseFieldIds: ReadonlySet<string>,
): boolean {
  return fillable.some(
    (f) =>
      f.required &&
      !isFieldValueComplete(f.kind, submittedValueById.get(f.id)) &&
      !priorResponseFieldIds.has(f.id),
  );
}
