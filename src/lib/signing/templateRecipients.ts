import type {
  DocumentModel,
  Recipient,
} from "@/lib/doceditor/model";

const SIGNING_FIELD_KINDS = new Set(["signature", "initials", "stamp"]);

export function looksLikeEmail(value: string | null | undefined): boolean {
  return Boolean(value?.trim() && /^\S+@\S+\.\S+$/.test(value.trim()));
}

export function hasSendReadyRecipients(doc: DocumentModel): boolean {
  const recipients = doc.recipients.filter(
    (recipient) => recipient.role !== "viewer",
  );
  return (
    recipients.length > 0 &&
    recipients.every((recipient) => looksLikeEmail(recipient.email))
  );
}

function recipientHint(recipient: Recipient): "dealer" | "customer" | null {
  const text = `${recipient.name} ${recipient.email}`.toLowerCase();
  if (/denago|dealer|company|staff|sales|representative|rep\b/.test(text)) {
    return "dealer";
  }
  if (/customer|client|buyer|purchaser|driver/.test(text)) {
    return "customer";
  }
  return null;
}

/**
 * Replace placeholder/template signing recipients without losing field placement.
 * Existing viewer recipients and their fields remain unchanged. Fields assigned to
 * old signers are mapped to the replacement recipients using role hints first and
 * stable order second. A single generic placeholder maps to the customer.
 */
export function remapTemplateSigningRecipients(
  doc: DocumentModel,
  replacements: Recipient[],
): Set<string> {
  const oldSigning = doc.recipients.filter(
    (recipient) => recipient.role !== "viewer",
  );
  const viewers = doc.recipients.filter(
    (recipient) => recipient.role === "viewer",
  );
  const mapping = new Map<string, string>();

  oldSigning.forEach((recipient, index) => {
    let replacementIndex = Math.min(index, replacements.length - 1);
    if (replacements.length === 2) {
      const hint = recipientHint(recipient);
      if (hint === "dealer") replacementIndex = 0;
      else if (hint === "customer") replacementIndex = 1;
      else if (oldSigning.length === 1) replacementIndex = 1;
    }
    const replacement = replacements[replacementIndex];
    if (replacement) mapping.set(recipient.id, replacement.id);
  });

  const recipientsWithFields = new Set<string>();
  for (const page of doc.pages) {
    page.overlayFields = page.overlayFields.map((field) => {
      const mapped = field.recipientId
        ? mapping.get(field.recipientId)
        : undefined;
      const recipientId = mapped ?? field.recipientId;
      if (recipientId && replacements.some((item) => item.id === recipientId)) {
        recipientsWithFields.add(recipientId);
      }
      return mapped ? { ...field, recipientId: mapped } : field;
    });
  }

  doc.recipients = [...replacements, ...viewers];
  return recipientsWithFields;
}

/** Recipients that already have a placed signature/initials/stamp field. */
export function recipientIdsWithFields(doc: DocumentModel): Set<string> {
  return new Set(
    doc.pages.flatMap((page) =>
      page.overlayFields
        .filter((field) => SIGNING_FIELD_KINDS.has(field.kind))
        .map((field) => field.recipientId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
}
