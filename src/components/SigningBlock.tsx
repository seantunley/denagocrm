"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import SignatureCapture from "@/components/signing/SignatureCapture";
import SignedDocPreview from "@/components/signing/SignedDocPreview";
import { formatDate, formatDateTime } from "@/lib/format";
import { isRequestClosed, lastValidDay } from "@/lib/signing/statusPolicy";
import type { ChosenPerson, WorkflowAsk } from "@/lib/signflow/compile";
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
  declineReason?: string | null;
};

export type SigningState = {
  requestId: string;
  status: string;
  createdAt: Date | string;
  sentAt: Date | string | null;
  completedAt: Date | string | null;
  expiresAt?: Date | string | null;
  rejection?: { label: string; by: string | null; reason: string | null; at: Date | string | null } | null;
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

/** What the sender has entered for one open step: a team member's id, "other" for someone outside it, or "". */
type Choice = { who: string; name: string; email: string };
const NOBODY: Choice = { who: "", name: "", email: "" };

/** The person a choice names, or null while it is incomplete. The server checks again. */
function asPerson(choice: Choice): ChosenPerson | null {
  if (!choice.who) return null;
  if (choice.who !== "other") return { userId: choice.who };
  const name = choice.name.trim();
  const email = choice.email.trim();
  return name.length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { name, email } : null;
}

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
  staff = [],
  defaultWorkflowId = null,
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
  /** `asks`: the steps on this record's path that the workflow left for the sender to fill. */
  workflows?: { id: string; name: string; asks?: WorkflowAsk[] }[];
  /** The team, offered for those steps. */
  staff?: { id: string; name: string }[];
  /** The workflow the card starts on (Settings → Signing workflows). */
  defaultWorkflowId?: string | null;
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
  // Starts on the workspace's default workflow. It was "" every time, so an
  // approval rule only applied for as long as everyone remembered to pick it.
  const [workflowId, setWorkflowId] = useState(defaultWorkflowId ?? "");
  // Who the sender has put in each step the chosen workflow left open, by node
  // id. `who` is a team member's id, "other" for someone outside it, or "".
  const [chosen, setChosen] = useState<Record<string, Choice>>({});
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

  // The steps the chosen workflow leaves to the sender, and who has been put in each.
  const asks = workflows.find((workflow) => workflow.id === workflowId)?.asks ?? [];
  const pick = (nodeId: string): Choice => chosen[nodeId] ?? NOBODY;
  const choose = (nodeId: string, change: Partial<Choice>) =>
    setChosen((all) => ({ ...all, [nodeId]: { ...(all[nodeId] ?? NOBODY), ...change } }));
  const everyoneChosen = asks.every((ask) => asPerson(pick(ask.nodeId)) !== null);

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

  // EVERY closed state, from the one shared definition. This compared against
  // three of the five by hand, so a request an approver had rejected — or one
  // that had expired — still read as out for signature: the card offered to
  // resend a dead link, Void was refused, and there was no way to start again.
  const active = Boolean(state) && !isRequestClosed(state!.status);
  const declined = state?.status === "declined" ? state.recipients.find((r) => r.declinedAt) : undefined;
  const rejected = state?.status === "rejected" ? state.rejection ?? { label: "", by: null, reason: null, at: null } : null;
  const expired = state?.status === "expired";
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
        {/* It said "Countersign in one click" on every quote. Whether we sign at all
            is the LAYOUT's decision — a quote layout with only the customer's
            signature block has nothing of ours to sign — so the card describes
            what always happens and the review window offers the countersignature
            when the document actually has one waiting. */}
        {kind === "quote"
          ? "Check the quote, then send it — the customer signs on their phone, which accepts the quote and wins the lead. If the layout carries our signature block, you countersign it in the review first."
          : `The customer opens a secure link, reviews ${refLabel}, and signs on their phone — no printing needed.`}
      </p>

      {/* Every way a request can end without a signature says so, with the
          reason, and leaves the start-again controls below it. The declined
          banner used to say "Void the request below" about a request that was
          already closed and had no such button. */}
      {declined && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 mb-3">
          <p className="text-xs text-red-300">
            ✗ Declined by {declined.name} on {formatDateTime(declined.declinedAt!)}. Nothing is out for signature now — send it again below if they change their mind.
          </p>
          <p className="mt-1 text-xs text-red-200">
            {declined.declineReason?.trim() ? `Their reason: “${declined.declineReason.trim()}”` : "They gave no reason."}
          </p>
        </div>
      )}
      {rejected && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 mb-3">
          <p className="text-xs text-red-300">
            ✗ Not approved{rejected.label ? ` at “${rejected.label}”` : ""}{rejected.by ? ` by ${rejected.by}` : ""}{rejected.at ? ` on ${formatDateTime(rejected.at)}` : ""}. It was not sent to the customer — change what needs changing and start again below.
          </p>
          <p className="mt-1 text-xs text-red-200">
            {rejected.reason?.trim() ? `Their reason: “${rejected.reason.trim()}”` : "They gave no reason."}
          </p>
        </div>
      )}
      {expired && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 mb-3">
          <p className="text-xs text-amber-200">
            ⏱ The signing link expired{state?.expiresAt ? ` after ${formatDate(lastValidDay(state.expiresAt))}` : ""} without being signed, so it no longer works.{" "}
            {kind === "quote" ? "Update the quote's valid-until date, then send it again below." : "Send it again below."}
          </p>
        </div>
      )}

      {kind === "quote" && dealerSignedAt && (
        <p className="text-xs text-emerald-400 mb-3">
          ✓ Countersigned by {dealerSignedByName} · {formatDateTime(dealerSignedAt)}
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

              {state.expiresAt && (
                <p className="text-[11px] text-slate-500">
                  The link stops working after {formatDate(lastValidDay(state.expiresAt))}{kind === "quote" ? ", the quote's valid-until date" : ""}.
                </p>
              )}

              <div className="flex gap-2 flex-wrap items-center">
                <button className="btn-secondary btn-sm" disabled={busy !== null} onClick={() => run("open", async () => { await openPreview(); return { ok: true }; })}>
                  👁 View document
                </button>
                <button className="btn-secondary btn-sm" disabled={busy !== null} onClick={() => run("resend", () => resendRecordSigning(kind, id, state.requestId))}>
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
                <option value="">Built-in — as the layout is drawn</option>
                {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}{w.id === defaultWorkflowId ? " (default)" : ""}</option>)}
              </select>
            </div>
          )}
          {/* A step the workflow leaves to whoever sends it — "choose at send", a
              role, a blank address. It was never asked for: the document went
              out to a recipient called "To be chosen" with nowhere to send it. */}
          {asks.length > 0 && (
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
              <p className="text-[11px] font-medium text-amber-200">
                Choose {asks.length === 1 ? "who fills this step" : `who fills these ${asks.length} steps`} before sending.
              </p>
              {asks.map((ask) => {
                const choice = pick(ask.nodeId);
                return (
                  <div key={ask.nodeId} className="space-y-1">
                    <label htmlFor={`ask-${ask.nodeId}`} className="block text-[11px] font-medium text-slate-400">
                      {ask.label}{ask.hint ? ` (${ask.hint})` : ""} — {ask.kind === "approver" ? "approves" : "signs"}
                    </label>
                    <select
                      id={`ask-${ask.nodeId}`}
                      value={choice.who}
                      onChange={(e) => choose(ask.nodeId, { who: e.target.value })}
                      className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                    >
                      <option value="">Choose…</option>
                      {staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                      <option value="other">Someone else — enter their details</option>
                    </select>
                    {choice.who === "other" && (
                      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        <input
                          value={choice.name}
                          onChange={(e) => choose(ask.nodeId, { name: e.target.value })}
                          placeholder="Full name"
                          aria-label={`${ask.label}: full name`}
                          className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                        />
                        <input
                          type="email"
                          value={choice.email}
                          onChange={(e) => choose(ask.nodeId, { email: e.target.value })}
                          placeholder="Email address"
                          aria-label={`${ask.label}: email address`}
                          className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
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
            disabled={busy !== null || !everyoneChosen}
            title={everyoneChosen ? undefined : "Choose who fills each step first"}
            onClick={() => run("start", () =>
              // undefined means "no explicit mode" — the workspace policy decides.
              //
              // The click PREPARES the document and opens it; it signs nothing.
              // It used to apply the sender's saved signature in the same click
              // under a button reading "Countersign & review" — on every quote,
              // including the ones whose layout has no block of ours to sign. The
              // review window already knows whose turn it is (run() opens it on
              // success), and offers "Countersign" there only when the document
              // is waiting on the person looking at it.
              startRecordSigning(
                kind, id, workflowId || undefined,
                identityChoice === "default" ? undefined : identityChoice,
                // Checked again on the server, which refuses a step left empty.
                asks.length > 0 ? Object.fromEntries(asks.map((ask) => [ask.nodeId, asPerson(pick(ask.nodeId))!])) : undefined,
              ),
            )}
          >
            {busy === "start" ? "Preparing…" : "👁 Review & send"}
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
          onRequestApproval={() => run("approval", () => sendRecordSigning(kind, id, preview.requestId))}
          // A button labelled "Resend" must take the resend path. sendRecordSigning
          // is the FIRST send: dispatchRequest's claim excludes an already-"sent"
          // request, so it would have reported a delivery failure every time.
          // Both carry the request this preview rendered: the server refuses to
          // send any other document than the one on screen.
          onSend={() => run("send", () => (preview.sent ? resendRecordSigning(kind, id, preview.requestId) : sendRecordSigning(kind, id, preview.requestId)))}
          onClose={() => { setPreview(null); setErr(null); setNote(null); refresh(); }}
        />
      )}
    </div>
  );
}
