"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import SignatureCapture from "@/components/signing/SignatureCapture";
import SignedDocPreview from "@/components/signing/SignedDocPreview";
import { formatDateTime } from "@/lib/format";
import {
  startRecordSigning,
  recordSigningLink,
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
  token: string;
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
  /**
   * Called whenever this card changes the record's signing state. On a page,
   * router.refresh() re-reads the props and that is enough. Inside the quote
   * editor the props come from an on-demand fetch that a route refresh cannot
   * reach, so the embedder refetches here — without it the card would keep
   * showing the countersign button after you had already countersigned.
   */
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [workflowId, setWorkflowId] = useState("");
  // Off by default: the customer sees the step only when someone decided this
  // particular document was worth it.
  // THREE states, because two cannot express "let the workspace decide".
  //
  // A checkbox always sends an explicit mode, so the money-attached policy
  // configured in Settings never got to decide the ordinary quote flow: the box
  // was unticked, the client sent "link", and an explicit choice outranks the
  // policy by design. The default is now the policy, and overriding it is a
  // deliberate act rather than the consequence of not touching a control.
  const [identityChoice, setIdentityChoice] = useState<"default" | "otp" | "link">("default");
  // The raw capability is not on this object and must not be: the row stores a
  // digest. Ask the server, which reveals or rotates under an access check.
  const [links, setLinks] = useState<Record<string, string>>({});
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<SignedDocView | null>(null);

  /** Re-read the record everywhere this card is mounted — route and embedder. */
  const refresh = useCallback(() => {
    router.refresh();
    onChanged?.();
  }, [router, onChanged]);

  /** Pull the document as it now stands and show it. */
  const openPreview = useCallback(async () => {
    const view = await signedRecordDoc(kind, id);
    if (!view) {
      setErr("The document could not be loaded.");
      return;
    }
    setPreview(view);
  }, [kind, id]);

  // Record already signed (via the hub or the historic legacy flow).
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
  const declined = state?.recipients.find((r) => r.declinedAt);
  // An envelope that exists but has not gone out yet is Denago's step, not the
  // customer's — showing them a signing link they have never been sent is how
  // the old card managed to look "sent" before anything was. One button, and
  // the document itself decides whether that means countersign or send.
  const notYetSent = Boolean(active) && !state?.sentAt;

  async function run(label: string, fn: () => Promise<ActionResult>) {
    setBusy(label); setErr(null); setNote(null);
    try {
      const res = await fn();
      if (!res.ok) {
        // A missing signature is not an error to read and dismiss — it is the
        // one thing standing between the click and the signature, so say what
        // to do rather than what went wrong.
        setErr(res.needsSignature ? "Add your signature below, then countersign." : res.error ?? "Something went wrong.");
        return;
      }
      if (typeof res.notified === "number" && res.notified > 0) {
        setNote(`Sent to ${res.notified} recipient(s).`);
      }
      // Every successful step lands back on the document: countersigning shows
      // what was signed, sending shows what went out.
      await openPreview();
      refresh();
    } catch { setErr("Something went wrong. Please try again."); }
    finally { setBusy(null); }
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
              {state.recipients.map((r) => (
                <div key={r.id} className="rounded-lg border border-input bg-card/50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium">{r.name}{r.email ? ` · ${r.email}` : ""}</span>
                    <span className="text-[11px] uppercase tracking-wide text-slate-400">
                      {r.signedAt ? "✓ signed" : r.viewedAt ? "👀 viewed" : r.status === "sent" ? "✉ sent" : "pending"}
                    </span>
                  </div>
                  {!r.signedAt && (
                    <div className="flex items-center gap-2 mt-2">
                      {links[r.id] ? (
                        <>
                          <input readOnly value={links[r.id]} className="input text-xs font-mono" />
                          <CopyButton text={links[r.id]} />
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={linkBusy === r.id}
                          onClick={async () => {
                            setLinkBusy(r.id);
                            try {
                              const result = await recordSigningLink(kind, id, r.id);
                              if ("url" in result) setLinks((prev) => ({ ...prev, [r.id]: result.url }));
                              else setErr(result.error);
                            } finally {
                              setLinkBusy(null);
                            }
                          }}
                        >
                          {linkBusy === r.id ? "Preparing…" : "Show link"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}

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
              <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground">
                <option value="">Built-in — Denago countersigns, then the customer</option>
                {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}
          <div className="rounded-md border border-input bg-card/50 px-2.5 py-2">
            <label className="mb-1 block text-[11px] font-medium text-slate-400">Verifying the signer</label>
            <select
              value={identityChoice}
              onChange={(e) => setIdentityChoice(e.target.value as "default" | "otp" | "link")}
              className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
            >
              <option value="default">Workspace default</option>
              <option value="otp">Require a one-time code</option>
              <option value="link">Link only</option>
            </select>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              The default follows your Signing security setting — normally a code for documents with
              money attached. A code goes to the email address or mobile number on file.
            </p>
          </div>
          <button
            className="btn-primary"
            disabled={busy !== null}
            onClick={() => run("start", async () => {
              // undefined means "no explicit mode" — the workspace policy decides.
              const started = await startRecordSigning(
                kind, id, workflowId || undefined,
                identityChoice === "default" ? undefined : identityChoice,
              );
              // The built-in quote flow is countersign-then-send, so do the
              // countersignature in the same click rather than making it a
              // separate button the user has to find.
              //
              // But only when the caller is ACTUALLY the next signer. A workflow
              // can put the customer — or another staff member — at the first
              // node, and countersignRecord refuses to sign in their name. Asking
              // regardless turned a perfectly started request into the flat error
              // "<customer> signs next — this is not yours to sign", and because
              // run() bails on a failed result the document never opened: the
              // quote was left locked behind a request the card would not show.
              // Ask the document who is up, then act as them or hand over.
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
          // Raising an internal approval gate is a first send, never a resend —
          // the approver has not been asked yet (that is what `raised: false`
          // means), and sendRecordSigning is the path that materialises the step.
          onRequestApproval={() => run("approval", () => sendRecordSigning(kind, id))}
          // A button labelled "Resend" must take the resend path. sendRecordSigning
          // is the FIRST send: dispatchRequest's claim excludes an already-"sent"
          // request, so it would have reported a delivery failure every time.
          onSend={() => run("send", () => (preview.sent ? resendRecordSigning(kind, id) : sendRecordSigning(kind, id)))}
          onClose={() => { setPreview(null); setErr(null); setNote(null); refresh(); }}
        />
      )}
    </div>
  );
}
