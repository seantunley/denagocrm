"use client";

import { useRef, useState } from "react";
import { useActionState } from "react";
import { sendWhatsAppMessage, type WaState } from "@/app/actions/whatsapp";
import { sendDmReply, type DmState } from "@/app/actions/messenger";

const QUICK_EMOJI = ["😀", "👍", "🙏", "🎉", "🔥", "❤️", "😂", "👌", "🚗", "⚡"];

/** Channel-aware reply box for the Social inbox: text, emoji, attachments. */
export default function InboxReply({
  channel,
  contactId,
  leadId,
  phone,
  revalidate,
}: {
  channel: "whatsapp" | "messenger" | "instagram";
  contactId?: string | null;
  leadId?: string | null;
  phone?: string | null;
  revalidate: string;
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
  const canAttach = channel !== "whatsapp"; // WhatsApp media send comes later

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

      <div className="flex items-start gap-2">
        <textarea
          ref={textRef}
          name="text"
          rows={1}
          className="input flex-1"
          placeholder={`Reply via ${channel === "whatsapp" ? "WhatsApp" : channel === "instagram" ? "Instagram" : "Messenger"}…`}
        />
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
              className="btn-secondary btn-sm mt-1"
              title="Attach an image, GIF, voice note or document (max 4MB)"
            >
              📎
            </button>
          </>
        )}
        <button className="btn-primary btn-sm mt-1">Send</button>
      </div>

      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
        {QUICK_EMOJI.map((e) => (
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
          <span className="text-xs text-slate-400 ml-2">
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
        {state?.error && <span className="text-xs text-red-400 ml-2">{state.error}</span>}
        {state?.ok && <span className="text-xs text-emerald-400 ml-2">{state.ok}</span>}
      </div>
    </form>
  );
}
