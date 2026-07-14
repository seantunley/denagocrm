import "server-only";
import type { Recipient, OverlayField } from "./model";

/**
 * Signing-provider boundary. The document builder produces a sealed PDF + a list
 * of recipients and their fields; an adapter decides what "send for signing"
 * means (internal seal-and-file today; DocuSign / PandaDoc / Documenso later).
 * Keeping this behind an interface keeps provider integration out of the editor.
 */

export type SignField = { kind: OverlayField["kind"]; recipientId: string | null; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string };

export type SendRequest = {
  title: string;
  pdf: Buffer;
  documentId: string | null;
  recipients: Recipient[];
  fields: SignField[];
};

export type SendResult = { ok: boolean; provider: string; reference?: string; url?: string; message: string };

export interface SigningAdapter {
  readonly name: string;
  send(req: SendRequest): Promise<SendResult>;
}

/**
 * Internal adapter — the sealed PDF is already filed in the Document repository;
 * this records the signing intent and returns a summary. Swap for a real provider
 * by implementing SigningAdapter and returning it from getSigningAdapter().
 */
const internalAdapter: SigningAdapter = {
  name: "internal",
  async send(req) {
    const assigned = req.fields.filter((f) => f.recipientId).length;
    const named = req.recipients.filter((r) => r.email).length;
    return {
      ok: true,
      provider: "internal",
      reference: req.documentId ?? undefined,
      message: `Sealed PDF filed. ${req.recipients.length} recipient(s), ${req.fields.length} field(s) (${assigned} assigned). ${named ? `${named} have email addresses — connect a signing provider to dispatch automatically.` : "Add recipient emails to dispatch."}`,
    };
  },
};

export function getSigningAdapter(): SigningAdapter {
  // Future: select by env (e.g. SIGNING_PROVIDER=docusign) and return that adapter.
  return internalAdapter;
}
