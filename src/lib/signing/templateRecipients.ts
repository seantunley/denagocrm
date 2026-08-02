import type {
  DocumentModel,
  Recipient,
} from "@/lib/doceditor/model";

const SIGNING_FIELD_KINDS = new Set(["signature", "initials", "stamp"]);

export function looksLikeEmail(value: string | null | undefined): boolean {
  return Boolean(value?.trim() && /^\S+@\S+\.\S+$/.test(value.trim()));
}

/** How a party recipient reads in the editor, where it has no name yet. */
export function recipientLabel(recipient: Recipient): string {
  if (recipient.party === "denago") return "Denago (whoever sends it)";
  if (recipient.party === "customer") return "The customer";
  return recipient.name || recipient.email || "Recipient";
}

export function hasSendReadyRecipients(doc: DocumentModel): boolean {
  const recipients = doc.recipients.filter(
    (recipient) => recipient.role !== "viewer",
  );
  return (
    recipients.length > 0 &&
    // A party recipient has no email in the template BY DESIGN — it is filled
    // in from the record at send time, so requiring one here would send every
    // party-based template down the invent-new-recipients path it exists to
    // replace.
    recipients.every(
      (recipient) => recipient.party !== "custom" || looksLikeEmail(recipient.email),
    )
  );
}

export type PartyPeople = {
  denago: { name: string; email: string | null };
  customer: { name: string; email: string | null };
};

/**
 * Fill in the real people behind a template's party recipients.
 *
 * Only ever writes name/email — the recipient's identity, colour, role and the
 * fields assigned to it are the template author's decisions and stay exactly as
 * placed. That is the whole point: the signature block ends up where it was
 * drawn, for the party it was drawn for.
 */
export function resolvePartyRecipients(
  doc: DocumentModel,
  people: PartyPeople,
): { denago: boolean; customer: boolean } {
  const found = { denago: false, customer: false };
  doc.recipients = doc.recipients.map((recipient) => {
    if (recipient.party !== "denago" && recipient.party !== "customer") return recipient;
    const person = people[recipient.party];
    found[recipient.party] = true;
    return {
      ...recipient,
      // The template may still carry a label the author typed ("Sales manager");
      // keep it when the resolved person has no name to offer.
      name: person.name || recipient.name,
      email: person.email ?? "",
    };
  });
  return found;
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
      // A declared party is the author saying it outright; the name pattern is
      // the guess we fall back to for templates written before parties existed.
      const hint =
        recipient.party === "denago"
          ? "dealer"
          : recipient.party === "customer"
            ? "customer"
            : recipientHint(recipient);
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
