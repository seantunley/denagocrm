"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import DealerSignPad from "@/components/DealerSignPad";
import { formatDateTime } from "@/lib/format";
import { startRecordSigning, resendRecordSigning, voidRecordSigning } from "@/app/actions/recordSigning";

const BASE = "https://crm.denagocpt.co.za";

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
}) {
  const router = useRouter();
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [modalUrl, setModalUrl] = useState<string | null>(null);

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

  const needsDealerSignature = kind === "quote" && !dealerSignedAt;
  const origin = typeof window !== "undefined" ? window.location.origin : BASE;
  const signerLink = (token: string) => `${origin}/signing/${token}`;
  const active = state && state.status !== "completed" && state.status !== "declined" && state.status !== "voided";
  const declined = state?.recipients.find((r) => r.declinedAt);

  async function run(label: string, fn: () => Promise<{ ok: boolean; error?: string; notified?: number; unreachable?: number; signFirstUrl?: string; modal?: boolean }>) {
    setBusy(label); setErr(null); setNote(null);
    try {
      const res = await fn();
      if (!res.ok) { setErr(res.error ?? "Something went wrong."); return; }
      // Sender's own first step → sign it in-context in a modal, don't leave the page.
      if (res.signFirstUrl && res.modal) { setModalUrl(res.signFirstUrl); return; }
      // Otherwise go to sign / the hub.
      if (res.signFirstUrl) { router.push(res.signFirstUrl); return; }
      if (typeof res.notified === "number") {
        // Truthful: distinguish delivered, no-contact-channel, and
        // had-a-channel-but-delivery-failed rather than claiming a send.
        setNote(
          res.notified > 0
            ? `Sent to ${res.notified} recipient(s).`
            : res.unreachable && res.unreachable > 0
              ? "Request ready — add a contact to notify."
              : "Request ready, but the notification could not be delivered — retry from the Signatures hub.",
        );
      }
      router.refresh();
    } catch { setErr("Something went wrong. Please try again."); }
    finally { setBusy(null); }
  }

  return (
    <div className="card">
      <h2 className="font-semibold mb-1">✍ Online signature</h2>
      <p className="text-xs text-slate-400 mb-4">
        {kind === "quote"
          ? "Step 1: Denago countersigns. Step 2: send the secure link — the customer signs on their phone, which accepts the quote and wins the lead."
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

      {needsDealerSignature ? (
        <DealerSignPad quoteId={id} hasSaved={Boolean(hasSavedSignature)} />
      ) : active && state ? (
        <div className="space-y-3">
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
                  <input readOnly value={signerLink(r.token)} className="input text-xs font-mono" />
                  <CopyButton text={signerLink(r.token)} />
                </div>
              )}
            </div>
          ))}

          <div className="flex gap-2 flex-wrap items-center">
            <button className="btn-secondary btn-sm" disabled={busy !== null} onClick={() => run("resend", () => resendRecordSigning(kind, id))}>
              {busy === "resend" ? "Sending…" : "✉️ Resend link"}
            </button>
            <a href={`/signatures/${state.requestId}`} className="btn-secondary btn-sm" title="Open in the Signatures hub">📊 Manage in hub</a>
            <button
              className="text-xs text-slate-500 hover:text-red-400 underline cursor-pointer"
              disabled={busy !== null}
              onClick={() => run("void", () => voidRecordSigning(kind, id))}
              title="The link stops working immediately; you can send a fresh one after."
            >
              {busy === "void" ? "Voiding…" : "Void request"}
            </button>
          </div>
          {kind === "quote" && (
            <p className="text-[11px] text-slate-500">
              🔒 While this request is active the quote is locked for editing — void it to make changes, then send a fresh one.
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
          <button className="btn-primary" disabled={busy !== null} onClick={() => run("send", () => startRecordSigning(kind, id, workflowId || undefined))}>
            {busy === "send" ? "Preparing…" : "Send for signing"}
          </button>
        </div>
      )}

      {err && <p className="text-xs text-red-400 mt-2">⚠ {err}</p>}
      {note && <p className="text-xs text-emerald-400 mt-2">{note}</p>}

      {modalUrl && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/80 p-3 sm:p-6" onClick={() => { setModalUrl(null); router.refresh(); }}>
          <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2">
              <span className="text-sm font-semibold text-white">Your signature</span>
              <button onClick={() => { setModalUrl(null); router.refresh(); }} className="rounded-md bg-slate-700 px-3 py-1 text-xs text-white hover:bg-slate-600">Done ✕</button>
            </div>
            <iframe title="Sign" src={modalUrl} className="flex-1 w-full bg-slate-900" />
          </div>
        </div>
      )}
    </div>
  );
}
