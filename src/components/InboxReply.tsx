"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { sendWhatsAppMessage, type WaState } from "@/app/actions/whatsapp";
import { sendDmReply, type DmState } from "@/app/actions/messenger";
import { saveConversationDraft, discardConversationDraft } from "@/app/actions/conversations";
import AiCheckButton from "@/components/AiCheckButton";

const QUICK_EMOJI = ["😀", "👍", "🙏", "🎉", "🔥", "❤️", "😂", "👌", "🚗", "⚡"];

/** Channel-aware reply box for the Social inbox: text, emoji, attachments. */
export default function InboxReply({
  channel,
  contactId,
  leadId,
  phone,
  revalidate,
  aiConfigured = false,
  conversationId = null,
  initialDraft = "",
  draftLockedBy = null,
}: {
  channel: "whatsapp" | "messenger" | "instagram";
  contactId?: string | null;
  leadId?: string | null;
  phone?: string | null;
  revalidate: string;
  aiConfigured?: boolean;
  /** When set, the reply text is auto-saved as a shared draft (with collision detection). */
  conversationId?: string | null;
  initialDraft?: string;
  /** Name of another staff member already drafting a reply here (server-detected on load). */
  draftLockedBy?: string | null;
}) {
  const [waState, waAction] = useActionState<WaState | undefined, FormData>(
    sendWhatsAppMessage,
    undefined
  );
  const [dmState, dmAction] = useActionState<DmState | undefined, FormData>(
    sendDmReply,
    undefined
  );
  const state = channel === "whatsapp" ? waState : dmState;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const canAttach = channel !== "whatsapp"; // WhatsApp media send comes later

  // Shared draft: autosave the in-progress reply so teammates see it and we can
  // warn on collision. Debounced; a collision means someone else is drafting.
  const [draftState, setDraftState] = useState<"idle" | "saving" | "saved">("idle");
  const [lockedBy, setLockedBy] = useState<string | null>(draftLockedBy);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onDraftInput() {
    if (!conversationId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setDraftState("saving");
    saveTimer.current = setTimeout(async () => {
      const body = textRef.current?.value ?? "";
      const res = await saveConversationDraft(conversationId, body);
      if ("collision" in res) {
        setLockedBy(res.collision.ownerName);
        setDraftState("idle");
      } else {
        setLockedBy(null);
        setDraftState("saved");
      }
    }, 700);
  }

  // On a successful send, clear the shared draft.
  useEffect(() => {
    if (state?.ok && conversationId) {
      void discardConversationDraft(conversationId);
      if (textRef.current) textRef.current.value = "";
      setDraftState("idle");
    }
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
    <form action={channel === "whatsapp" ? waAction : dmAction} className="mt-3">
      {channel === "whatsapp" ? (
        <>
          <input type="hidden" name="phone" value={phone ?? ""} />
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          {leadId && <input type="hidden" name="leadId" value={leadId} />}
        </>
      ) : (
        <input type="hidden" name="contactId" value={contactId ?? ""} />
      )}
      <input type="hidden" name="revalidate" value={revalidate} />

      <div className="flex items-center gap-1.5">
        <textarea
          ref={textRef}
          name="text"
          rows={1}
          defaultValue={initialDraft}
          onInput={onDraftInput}
          className="input flex-1 py-1.5 text-sm resize-none"
          placeholder={`Reply via ${channel === "whatsapp" ? "WhatsApp" : channel === "instagram" ? "Instagram" : "Messenger"}…`}
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

      <div className="mt-1 flex items-center gap-2">
        <AiCheckButton
          getDraft={() => textRef.current?.value ?? ""}
          contactId={contactId}
          leadId={leadId}
          configured={aiConfigured}
        />
        {conversationId && lockedBy && (
          <span className="text-[11px] text-amber-300" title="Their draft is protected — yours won't overwrite it">
            ✋ {lockedBy} is also replying
          </span>
        )}
        {conversationId && !lockedBy && draftState === "saving" && (
          <span className="text-[11px] text-slate-500">saving draft…</span>
        )}
        {conversationId && !lockedBy && draftState === "saved" && (
          <span className="text-[11px] text-slate-500">draft saved</span>
        )}
      </div>

      {(showEmoji || fileName || state?.error || state?.ok) && (
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
        </div>
      )}
    </form>
  );
}
