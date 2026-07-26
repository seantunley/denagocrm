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
