"use client";

import { AlertTriangle, Send, X } from "lucide-react";

export interface WizardRecipient {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface WizardField {
  recipientId: string | null;
  required: boolean;
}

/**
 * Review-and-send modal for a builder document. Replaces the one-shot "Prepare
 * for signing" button: the user confirms who signs and what they fill, then
 * chooses "Send now" (dispatch immediately) or "Save as draft" (the old
 * behaviour — file it and finish sending from the Signatures hub).
 *
 * Pure/presentational: it renders what the editor already holds and calls back.
 * The server action owns validation and dispatch, so the reachability rule shown
 * here is a hint, not the gate.
 */
export function SignSendWizard({
  open,
  onClose,
  recipients,
  fields,
  busy,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  recipients: WizardRecipient[];
  fields: WizardField[];
  busy: boolean;
  onConfirm: (dispatch: boolean) => void;
}) {
  if (!open) return null;

  const signers = recipients.filter((r) => r.role !== "viewer");
  const reachableSigners = signers.filter((r) => r.email.trim() !== "");
  const sharedFields = fields.filter((f) => f.recipientId === null).length;
  const fieldsFor = (id: string) => fields.filter((f) => f.recipientId === id).length;
  const canSend = reachableSigners.length > 0 && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-16"
      onClick={busy ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Send for signing"
    >
      <div className="card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Send for signing</h2>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} disabled={busy} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {signers.length === 0 ? (
            <p className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
              <AlertTriangle className="size-4 flex-shrink-0" />
              No signer in this document yet. Add a recipient in the editor first.
            </p>
          ) : (
            <>
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recipients ({signers.length})
                </p>
                <ul className="space-y-2">
                  {recipients.map((r) => {
                    const noEmail = r.role !== "viewer" && r.email.trim() === "";
                    const count = fieldsFor(r.id);
                    return (
                      <li key={r.id} className="flex items-start justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                            {r.name || "Unnamed recipient"}
                            <span className="text-[10px] uppercase text-muted-foreground">{r.role}</span>
                          </div>
                          <div className={`truncate text-[11px] ${noEmail ? "text-amber-300" : "text-muted-foreground"}`}>
                            {r.email.trim() || (r.role === "viewer" ? "view only" : "⚠ no email — can’t be sent")}
                          </div>
                        </div>
                        <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                          {count} field{count === 1 ? "" : "s"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {sharedFields > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {sharedFields} shared field{sharedFields === 1 ? "" : "s"} any signer can complete.
                </p>
              )}

              {reachableSigners.length === 0 && (
                <p className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
                  <AlertTriangle className="size-4 flex-shrink-0" />
                  No signer has an email yet. You can save a draft and add contact details from the Signatures hub.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {signers.length > 0 && (
            <>
              <button type="button" className="btn-secondary btn-sm" onClick={() => onConfirm(false)} disabled={busy}>
                Save as draft
              </button>
              <button type="button" className="btn-primary btn-sm" onClick={() => onConfirm(true)} disabled={!canSend} title={canSend ? "Prepare and send to recipients now" : "Add a signer with an email to send now"}>
                <Send className="size-4" />
                {busy ? "Working…" : "Send now"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
