"use client";

import { useEffect, useRef, useState } from "react";
import type { SignedDocView } from "@/app/actions/recordSigning";
import ModalPortal from "@/components/ui/modal-portal";

/**
 * The countersigned document, on screen, before it goes anywhere.
 *
 * Rendered INLINE from the same sheet HTML the signing surface uses — not in an
 * iframe pointed at a page inside the app shell. The old modal did that, so the
 * app's own mobile navigation rendered underneath the document and sat over the
 * signing controls: a bar of unrelated buttons a hand's width from "Sign".
 */
export default function SignedDocPreview({
  view,
  busy,
  error,
  note,
  onCountersign,
  onSend,
  onRequestApproval,
  onClose,
}: {
  view: SignedDocView;
  busy: string | null;
  error: string | null;
  note: string | null;
  onCountersign: () => void;
  onSend: () => void;
  onRequestApproval: () => void;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fit the A4 sheet to whatever width the dialog gives us; never magnify.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / view.sheets.width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view.sheets.width]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // "Countersign as Denago" is offered ONLY when the document says the caller is
  // who it is waiting for. On a workflow whose next node is the customer this is
  // false, and the card offers to send instead of to sign in their name.
  const awaitingMe = view.next?.isMe ?? false;
  const recipient = view.next;
  // An internal approval gate has no recipient at all, so `next` is null for it.
  // Without this branch the footer read "Everyone has signed" over a request
  // nobody could move.
  const approval = !recipient ? view.approval : null;

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-950/85 p-3 sm:p-6" onClick={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-700 px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{view.title}</p>
            <p className="text-[11px] text-slate-400">
              {awaitingMe
                ? "Awaiting your countersignature"
                : recipient
                  ? view.sent
                    ? `Sent to ${recipient.name} — awaiting their signature`
                    : `Ready to send to ${recipient.name}`
                  : approval
                    ? approval.raised
                      ? `Awaiting internal approval — ${approval.label}`
                      : `Ready to send for approval — ${approval.label}`
                    : "Fully signed"}
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md bg-slate-700 px-3 py-1.5 text-xs text-white hover:bg-slate-600">
            Close ✕
          </button>
        </div>

        <div ref={wrapRef} className="flex-1 overflow-auto bg-slate-800 p-3 sm:p-5">
          <style dangerouslySetInnerHTML={{ __html: view.sheets.css }} />
          {view.sheets.pages.map((pageHtml, index) => (
            <div
              key={index}
              style={{ width: view.sheets.width * scale, height: view.sheets.height * scale }}
              className="relative mx-auto mb-4 bg-white shadow-xl"
            >
              <div
                style={{
                  width: view.sheets.width,
                  height: view.sheets.height,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                }}
                className="absolute left-0 top-0"
              >
                <div className="sg-sheet absolute inset-0" dangerouslySetInnerHTML={{ __html: pageHtml }} />
                {view.stamps
                  .filter((stamp) => stamp.page === index)
                  .map((stamp, si) => (
                    <div
                      key={si}
                      style={{ position: "absolute", left: stamp.x, top: stamp.y, width: stamp.width, height: stamp.height }}
                      className="pointer-events-none flex items-end justify-center"
                    >
                      {stamp.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={stamp.image} alt="Signature" className="max-h-full max-w-full object-contain" />
                      ) : (
                        <span className="w-full text-[13px] text-slate-900">{stamp.text ?? ""}</span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-slate-700 px-4 py-3">
          {error && <p className="mb-2 text-xs text-red-400">⚠ {error}</p>}
          {note && <p className="mb-2 text-xs text-emerald-400">{note}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {awaitingMe ? (
              <button className="btn-primary" disabled={busy !== null} onClick={onCountersign}>
                {busy === "countersign" ? "Signing…" : "✍ Countersign as Denago"}
              </button>
            ) : recipient ? (
              <button className="btn-primary" disabled={busy !== null} onClick={onSend}>
                {busy === "send"
                  ? "Sending…"
                  : view.sent
                    ? `✉️ Resend to ${recipient.name}`
                    : `✉️ Send to ${recipient.name}`}
              </button>
            ) : approval && !approval.raised ? (
              <button className="btn-primary" disabled={busy !== null} onClick={onRequestApproval}>
                {busy === "approval" ? "Sending…" : `✉️ Send for approval`}
              </button>
            ) : null}
            <span className="text-[11px] text-slate-500">
              {awaitingMe
                ? "Your saved signature is applied to this document — the customer is not contacted yet."
                : recipient
                  ? `${recipient.email || "No email on file"} · they sign on their phone, no printing needed.`
                  : approval
                    ? approval.raised
                      ? "The approver has the document — the flow continues once they decide."
                      : "Nobody has been contacted yet. Sending asks the approver to review it."
                    : "Everyone has signed. The sealed PDF is filed in the customer's documents."}
            </span>
          </div>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
