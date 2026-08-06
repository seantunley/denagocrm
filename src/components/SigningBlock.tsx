"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import SignatureCapture from "@/components/signing/SignatureCapture";
import SignedDocPreview from "@/components/signing/SignedDocPreview";
import { formatDateTime } from "@/lib/format";
import { revealSigningLink } from "@/app/actions/signingLinks";
import {
  startRecordSigning,
  countersignRecord,
  sendRecordSigning,
  resendRecordSigning,
  voidRecordSigning,
  signedRecordDoc,
  type SignedDocView,
} from "@/app/actions/recordSigning";

export type SigningRecipientView = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  viewedAt: Date | string | null;
  signedAt: Date | string | null;
  declinedAt: Date | string | null;
};

export type SigningState = {
  requestId: string;
  status: string;
  createdAt: Date | string;
  sentAt: Date | string | null;
  completedAt: Date | string | null;
  recipients: SigningRecipientView[];
} | null;

type ActionResult = {
  ok: boolean;
  error?: string;
  notified?: number;
  unreachable?: number;
  preview?: boolean;
  needsSignature?: boolean;
};

/** "Send for signature" card on quote / job card pages — driven by the signing hub. */
export default function SigningBlock({
  kind,
  id,
  refLabel,
  signedAt,
  signedByName,
  signedPdfHash,
  dealerSignedAt,
  dealerSignedByName,
  hasSavedSignature,
  state,
  workflows = [],
  onChanged,
}: {
  kind: "quote" | "jobcard";
  id: string;
  refLabel: string;
  signedAt: Date | string | null;
  signedByName: string | null;
  signedPdfHash?: string | null;
  dealerSignedAt?: Date | string | null;
  dealerSignedByName?: string | null;
  hasSavedSignature?: boolean;
  state: SigningState;
  workflows?: { id: string; name: string }[];
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<SignedDocView | null>(null);
  const [revealedLinks, setRevealedLinks] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    router.refresh();
    onChanged?.();
  }, [router, onChanged]);

  const openPreview = useCallback(async () => {
    const view = await signedRecordDoc(kind, id);
    if (!view) {
      setErr("The document could not be loaded.");
      return;
    }
    setPreview(view);
  }, [kind, id]);

  if (signedAt) {
    return (
      <div className="card bg-emerald-500/10 border-emerald-500/30">
        <p className="text-sm text-emerald-300">
          ✍ Signed online by <b>{signedByName}</b> on {formatDateTime(signedAt)}. The sealed PDF is filed in the customer&apos;s documents.
        </p>
        {signedPdfHash && (
          <p className="text-[11px] text-emerald-400/60 mt-1 font-mono">Tamper-evidence SHA-256: {signedPdfHash}</p>
        )}
      </div>
    );
  }

  const active = state && state.status !== "completed" && state.status !== "declined" && state.status !== "voided";
  const declined = state?.recipients.find((recipient) => recipient.declinedAt);
  const notYetSent = Boolean(active) && !state?.sentAt;

  async function run(label: string, fn: () => Promise<ActionResult>) {
    setBusy(label); setErr(null); setNote(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setErr(res.needsSignature ? "Add your signature below, then countersign." : res.error ?? "Something went wrong.");
        return;
      }
      if (typeof res.notified === "number" && res.notified > 0) {
        setNote(`Sent to ${res.notified} recipient(s).`);
      }
      await openPreview();
      refresh();
    } catch { setErr("Something went wrong. Please try again."); }
    finally { setBusy(null); }
  }

  async function reveal(recipientId: string) {
    const label = `reveal:${recipientId}`;
    setBusy(label); setErr(null); setNote(null);
    try {
      const result = await revealSigningLink(recipientId);
      if (!result.ok || !result.url) {
        setErr(result.error ?? "The secure link could not be revealed.");
        return;
      }
      setRevealedLinks((current) => ({ ...current, [recipientId]: result.url! }));
      setNote("Signing link revealed and recorded in the audit trail. Treat it as a personal capability.");
    } catch {
      setErr("The secure link could not be revealed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 className="font-semibold mb-1">✍ Online signature</h2>
      <p className="text-xs text-slate-400 mb-4">
        {kind === "quote"
          ? "Countersign for Denago in one click, check the signed quote, then send it — the customer signs on their phone, which accepts the quote and wins the lead."
          : `The customer opens a secure link, reviews ${refLabel}, and signs on their phone — no printing needed.`}
      </p>

      {declined && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 mb-3">
          <p className="text-xs text-red-300">
            ✗ Declined by the customer on {formatDateTime(declined.declinedAt!)}. Void the request below and send a fresh one if they change their mind.
          </p>
        </div>
      )}

      {kind === "quote" && dealerSignedAt && (
        <p className="text-xs text-emerald-400 mb-3">
          ✓ Countersigned for Denago by {dealerSignedByName} · {formatDateTime(dealerSignedAt)}
        </p>
      )}

      {active && state ? (
        <div className="space-y-3">
          {notYetSent ? (
            <button className="btn-primary" disabled={busy !== null} onClick={() => run("open", async () => { await openPreview(); return { ok: true }; })}>
              {busy === "open" ? "Opening…" : "👁 Review & send"}
            </button>
          ) : (
            <>
              {state.recipients.map((recipient) => {
                const revealed = revealedLinks[recipient.id];
                return (
                  <div key={recipient.id} className="rounded-lg border border-input bg-card/50 px-3 py-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-sm font-medium">{recipient.name}{recipient.email ? ` · ${recipient.email}` : ""}</span>
                      <span className="text-[11px] uppercase tracking-wide text-slate-400">
                        {recipient.signedAt ? "✓ signed" : recipient.viewedAt ? "👀 viewed" : recipient.status === "sent" ? "✉ sent" : "pending"}
                      </span>
                    </div>
                    {!recipient.signedAt && (
                      <div className="mt-2">
                        {revealed ? (
                          <div className="flex items-center gap-2">
                            <input readOnly value={revealed} className="input text-xs font-mono" />
                            <CopyButton text={revealed} />
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            disabled={busy !== null}
                            onClick={() => reveal(recipient.id)}
                          >
                            {busy === `reveal:${recipient.id}` ? "Revealing…" : "🔐 Reveal secure link"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="flex gap-2 flex-wrap items-center">
                <button className="btn-secondary btn-sm" disabled={busy !== null} onClick={() => run("open", async () => { await openPreview(); return { ok: true }; })}>
                  👁 View document
                </button>
                <button className="btn-secondary btn-sm" disabled={busy !== null} onClick={() => run("resend", () => resendRecordSigning(kind, id))}>
                  {busy === "resend" ? "Sending…" : "✉️ Resend link"}
                </button>
                <a href={`/signatures/${state.requestId}`} className="btn-secondary btn-sm" title="Open in the Signatures hub">📊 Manage in hub</a>
              </div>
            </>
          )}

          <div className="flex gap-2 flex-wrap items-center">
            <button
              className="text-xs text-slate-500 hover:text-red-400 underline cursor-pointer"
              disabled={busy !== null}
              onClick={() => run("void", () => voidRecordSigning(kind, id))}
              title="The link stops working immediately; you can send a fresh one after."
            >
              {busy === "void" ? "Discarding…" : notYetSent ? "Discard this document" : "Void request"}
            </button>
          </div>
          {kind === "quote" && (
            <p className="text-[11px] text-slate-500">
              🔒 While this document is open the quote is locked for editing — discard it to make changes, then start again.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {kind === "quote" && workflows.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-slate-400">Signing workflow</label>
              <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground">
                <option value="">Built-in — Denago countersigns, then the customer</option>
                {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
              </select>
            </div>
          )}
          <button
            className="btn-primary"
            disabled={busy !== null}
            onClick={() => run("start", async () => {
              const started = await startRecordSigning(kind, id, workflowId || undefined);
              if (!started.ok || !started.preview) return started;
              const view = await signedRecordDoc(kind, id);
              if (view?.next?.isMe) return countersignRecord(kind, id);
              return started;
            })}
          >
            {busy === "start"
              ? "Preparing…"
              : kind === "quote"
                ? "✍ Countersign & review"
                : "Send for signing"}
          </button>
        </div>
      )}

      {err && <p className="text-xs text-red-400 mt-2">⚠ {err}</p>}
      {note && <p className="text-xs text-emerald-400 mt-2">{note}</p>}

      {kind === "quote" && (
        <div className="mt-4 border-t border-input pt-3">
          <SignatureCapture hasSaved={Boolean(hasSavedSignature)} onSaved={refresh} compact />
        </div>
      )}

      {preview && (
        <SignedDocPreview
          view={preview}
          busy={busy}
          error={err}
          note={note}
          onCountersign={() => run("countersign", () => countersignRecord(kind, id))}
          onRequestApproval={() => run("approval", () => sendRecordSigning(kind, id))}
          onSend={() => run("send", () => (preview.sent ? resendRecordSigning(kind, id) : sendRecordSigning(kind, id)))}
          onClose={() => { setPreview(null); setErr(null); setNote(null); refresh(); }}
        />
      )}
    </div>
  );
}
