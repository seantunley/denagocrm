"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { sendWhatsAppMessage, type WaState } from "@/app/actions/whatsapp";
import { sendDmReply, type DmState } from "@/app/actions/messenger";
import { saveConversationDraft, discardConversationDraft } from "@/app/actions/conversations";
import { draftCollision, type DraftCollision } from "@/lib/conversationDraft";
import AiCheckButton from "@/components/AiCheckButton";
import { enterIntent, readEnterSends, writeEnterSends } from "@/lib/enterToSend";

const QUICK_EMOJI = ["😀", "👍", "🙏", "🎉", "🔥", "❤️", "😂", "👌", "🚗", "⚡"];

/** How long after the last keystroke the draft is saved. */
const AUTOSAVE_IDLE_MS = 1_500;

/** Channel-aware reply box for the Social inbox: text, emoji, attachments. */
export default function InboxReply({
  channel,
  contactId,
  leadId,
  phone,
  revalidate,
  aiConfigured = false,
  conversationId,
  draft,
  viewerId,
}: {
  channel: "whatsapp" | "messenger" | "instagram";
  contactId?: string | null;
  leadId?: string | null;
  phone?: string | null;
  revalidate: string;
  aiConfigured?: boolean;
  /**
   * Draft persistence is OPT-IN: without a conversationId the box behaves exactly
   * as it did before. /messages renders the same component and has no
   * conversation resolved, and a reply box that silently stopped saving would be
   * worse than one that never claimed to.
   */
  conversationId?: string | null;
  draft?: { ownerId: string; ownerName: string; body: string; updatedAt: Date } | null;
  viewerId?: string | null;
}) {
  const [waState, waAction, waPending] = useActionState<WaState | undefined, FormData>(
    sendWhatsAppMessage,
    undefined
  );
  const [dmState, dmAction, dmPending] = useActionState<DmState | undefined, FormData>(
    sendDmReply,
    undefined
  );
  const state = channel === "whatsapp" ? waState : dmState;
  // useActionState's third value. Discarding it left the keyboard with no idea a
  // send was already in flight.
  const pending = channel === "whatsapp" ? waPending : dmPending;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const canAttach = channel !== "whatsapp"; // WhatsApp media send comes later
  const formRef = useRef<HTMLFormElement>(null);
  // Defaults to true and is corrected after mount. Reading localStorage during
  // render would differ between server and client markup; starting at the
  // documented default means the first paint is never wrong about the default.
  const [enterSends, setEnterSends] = useState(true);
  useEffect(() => {
    setEnterSends(readEnterSends(typeof window === "undefined" ? null : window.localStorage));
  }, []);

  /**
   * One identity per COMPOSITION — not per message, and not per attempt.
   *
   * If a send fails ambiguously — the provider may or may not have accepted it —
   * pressing Send again must resolve to the message already queued rather than
   * deliver a second copy, so this cannot change on re-render or on failure. But
   * it must not be the whole key either: a person whose send failed usually
   * EDITS the message before retrying, and a key that ignored the text would
   * discard the correction as a duplicate and deliver the original.
   *
   * So the box supplies the composition and the server folds in what is actually
   * being sent. Same text resubmitted → same key → dedupes. Corrected text →
   * different key → sends. This value changes only once a send is confirmed,
   * which is what keeps two deliberately identical replies two messages.
   */
  const [compositionId, setCompositionId] = useState<string>("");
  useEffect(() => {
    if (!compositionId) setCompositionId(crypto.randomUUID());
  }, [compositionId]);
  useEffect(() => {
    if (state?.ok) setCompositionId(crypto.randomUUID());
  }, [state?.ok]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const intent = enterIntent(
      {
        key: event.key,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        // React exposes this on the native event; it is true while an IME is
        // composing, when Enter belongs to the input method and not to us.
        isComposing: (event.nativeEvent as KeyboardEvent).isComposing,
        repeat: event.repeat,
      },
      enterSends,
      pending,
    );
    if (intent === "ignore") return;
    if (intent === "send") {
      event.preventDefault();
      // requestSubmit, not submit(): it runs the form's own handlers and native
      // validation, so the key behaves exactly like pressing Send.
      formRef.current?.requestSubmit();
      return;
    }
    // Newline. Inserted explicitly rather than left to the default, because
    // Alt+Enter does not reliably produce one across browsers the way Shift+Enter
    // does — and the whole point is that the documented shortcut works.
    event.preventDefault();
    const el = event.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = `${el.value.slice(0, start)}
${el.value.slice(end)}`;
    el.selectionStart = el.selectionEnd = start + 1;
  }

  const drafting = Boolean(conversationId);
  // Whose draft is on the server, decided with the SAME function the action uses.
  // Deciding it again here by hand is how the client and the server come to
  // disagree about who owns a thread.
  const heldByColleague: DraftCollision | null =
    drafting && draft && viewerId
      ? draftCollision(
          { ownerId: draft.ownerId, ownerName: draft.ownerName, updatedAt: new Date(draft.updatedAt) },
          viewerId,
          new Date(),
        )
      : null;
  // Restored only when it is YOUR draft. Showing a colleague's half-written reply
  // in your box invites you to send it as your own.
  const restored = drafting && draft && draft.ownerId === viewerId ? draft.body : "";

  const [blocked, setBlocked] = useState<DraftCollision | null>(heldByColleague);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending autosave must not fire after the thread is closed — the modal
  // unmounts on close, and a late save would write into a conversation the person
  // has already navigated away from.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function queueDraftSave() {
    if (!conversationId || blocked) return;
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const body = textRef.current?.value ?? "";
      try {
        const result = await saveConversationDraft(conversationId, body);
        // A collision stops autosaving entirely rather than retrying: the point is
        // not to overwrite, and a box that kept trying would overwrite the moment
        // the colleague's draft went stale.
        if (result.collision) setBlocked(result.collision);
        else setSaved(true);
      } catch {
        // The draft is a convenience. A failed save must never interrupt a reply
        // in progress, so it is silent — the send path reports its own errors.
      }
    }, AUTOSAVE_IDLE_MS);
  }

  // Once the reply is actually sent, the draft has served its purpose. Discarding
  // is scoped server-side to the actor's OWN draft, so this cannot clobber the
  // colleague's draft the collision check protected.
  // No setState here: the indicator below is already gated on `!state?.ok`, so
  // clearing it in the effect would only add a render pass — and setting state
  // from an effect is what react-hooks/set-state-in-effect exists to stop.
  useEffect(() => {
    if (!state?.ok || !conversationId) return;
    if (timer.current) clearTimeout(timer.current);
    void discardConversationDraft(conversationId).catch(() => {});
  }, [state?.ok, conversationId]);

  function addEmoji(e: string) {
    const el = textRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, start) + e + el.value.slice(el.selectionEnd ?? start);
    el.focus();
    el.selectionStart = el.selectionEnd = start + e.length;
  }

  return (
    <form ref={formRef} action={channel === "whatsapp" ? waAction : dmAction} className="mt-3">
      {/* The warning goes ABOVE the box, before anything is typed. Told afterwards,
          the person has already written the duplicate reply. */}
      {blocked && (
        <p
          role="status"
          className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200"
        >
          <strong className="font-semibold">{blocked.ownerName}</strong> is already replying to this
          conversation. Your draft will not be saved — check with them before sending.
        </p>
      )}
      {channel === "whatsapp" ? (
        <>
          <input type="hidden" name="phone" value={phone ?? ""} />
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          {leadId && <input type="hidden" name="leadId" value={leadId} />}
        </>
      ) : (
        <>
          <input type="hidden" name="contactId" value={contactId ?? ""} />
          {/* The channel this box was rendered for. The server prefers the
              Conversation when one exists and re-checks this against the
              contact's identities either way — it is a statement of which
              thread is open, not a licence to pick a delivery route. */}
          <input type="hidden" name="channel" value={channel} />
          {conversationId && <input type="hidden" name="conversationId" value={conversationId} />}
        </>
      )}
      <input type="hidden" name="revalidate" value={revalidate} />
      <input type="hidden" name="compositionId" value={compositionId} />

      <div className="flex items-center gap-1.5">
        <textarea
          ref={textRef}
          name="text"
          rows={1}
          className="input flex-1 py-1.5 text-sm resize-none"
          placeholder={`Reply via ${channel === "whatsapp" ? "WhatsApp" : channel === "instagram" ? "Instagram" : "Messenger"}…`}
          onKeyDown={onKeyDown}
          // defaultValue, not value: the box stays uncontrolled, so restoring a
          // draft cannot fight the emoji inserter (which writes el.value directly)
          // or re-render on every keystroke.
          defaultValue={restored}
          onChange={drafting ? queueDraftSave : undefined}
        />
        <button
          type="button"
          onClick={() => setShowEmoji((v) => !v)}
          className={`h-8 w-8 rounded-lg text-base leading-none cursor-pointer transition-colors ${
            showEmoji ? "bg-slate-700" : "hover:bg-slate-800"
          }`}
          title="Emoji"
        >
          🙂
        </button>
        {canAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              name="file"
              accept="image/*,image/gif,audio/*,video/*,.pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={`h-8 w-8 rounded-lg text-base leading-none cursor-pointer transition-colors ${
                fileName ? "bg-slate-700" : "hover:bg-slate-800"
              }`}
              title="Attach an image, GIF, voice note or document (max 4MB)"
            >
              📎
            </button>
          </>
        )}
        <button className="btn-primary btn-sm">Send</button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={enterSends}
            onChange={(event) => {
              setEnterSends(event.target.checked);
              writeEnterSends(typeof window === "undefined" ? null : window.localStorage, event.target.checked);
            }}
          />
          Enter sends
          <span className="text-muted-foreground/70">({enterSends ? "Alt+Enter" : "Enter"} for a new line)</span>
        </label>
        <AiCheckButton
          getDraft={() => textRef.current?.value ?? ""}
          contactId={contactId}
          leadId={leadId}
          configured={aiConfigured}
        />
      </div>

      {(showEmoji || fileName || state?.error || state?.ok || saved) && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          {showEmoji &&
            QUICK_EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => addEmoji(e)}
                className="text-base leading-none hover:scale-125 transition-transform cursor-pointer"
              >
                {e}
              </button>
            ))}
          {fileName && (
            <span className="text-xs text-slate-400">
              📎 {fileName}{" "}
              <button
                type="button"
                className="text-slate-500 hover:text-red-400 cursor-pointer"
                onClick={() => {
                  if (fileRef.current) fileRef.current.value = "";
                  setFileName("");
                }}
              >
                ✕
              </button>
            </span>
          )}
          {state?.error && <span className="text-xs text-red-400">{state.error}</span>}
          {state?.ok && <span className="text-xs text-emerald-400">{state.ok}</span>}
          {saved && !state?.ok && <span className="text-xs text-slate-400">Draft saved</span>}
        </div>
      )}
    </form>
  );
}
