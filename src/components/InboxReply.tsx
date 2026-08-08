"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { sendWhatsAppMessage, type WaState } from "@/app/actions/whatsapp";
import { sendDmReply, type DmState } from "@/app/actions/messenger";
import AiCheckButton from "@/components/AiCheckButton";
import { enterIntent, readEnterSends, writeEnterSends } from "@/lib/enterToSend";

const QUICK_EMOJI = ["😀", "👍", "🙏", "🎉", "🔥", "❤️", "😂", "👌", "🚗", "⚡"];

/** Channel-aware reply box for the Social inbox: text, emoji, attachments. */
export default function InboxReply({
  channel,
  contactId,
  leadId,
  phone,
  revalidate,
  aiConfigured = false,
}: {
  channel: "whatsapp" | "messenger" | "instagram";
  contactId?: string | null;
  leadId?: string | null;
  phone?: string | null;
  revalidate: string;
  aiConfigured?: boolean;
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
  const formRef = useRef<HTMLFormElement>(null);
  // Defaults to true and is corrected after mount. Reading localStorage during
  // render would differ between server and client markup; starting at the
  // documented default means the first paint is never wrong about the default.
  const [enterSends, setEnterSends] = useState(true);
  useEffect(() => {
    setEnterSends(readEnterSends(typeof window === "undefined" ? null : window.localStorage));
  }, []);

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
      },
      enterSends,
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
          className="input flex-1 py-1.5 text-sm resize-none"
          placeholder={`Reply via ${channel === "whatsapp" ? "WhatsApp" : channel === "instagram" ? "Instagram" : "Messenger"}…`}
          onKeyDown={onKeyDown}
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
