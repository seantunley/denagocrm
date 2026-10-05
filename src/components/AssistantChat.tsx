"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Mic, Paperclip, Smile, Sparkles, Square, X } from "lucide-react";
import { shrinkToJpeg } from "@/components/shrinkImage";
import { askStreaming } from "@/components/askStream";
import { IMAGE_MAX_SIDE, MAX_IMAGE_BYTES } from "@/lib/assistantImage";
import { askCrmAction } from "@/app/actions/assistant";
import { transcribeQuestion } from "@/app/actions/voice";
import type { AssistantRow } from "@/lib/crmAssistant";
import { audioForm, useVoiceRecorder } from "@/components/useVoiceRecorder";
import type { ActionCard } from "@/lib/assistantActions";
import AssistantActionCard from "@/components/AssistantActionCard";

type Turn = { question: string; answer?: string; error?: string; rows: AssistantRow[]; learned?: number; actions?: ActionCard[]; choices?: string[] };

// The OS picker (Win + . / Ctrl + Cmd + Space) has everything; these are one tap away.
const EMOJIS = ["👍", "🙏", "😊", "😂", "🔥", "✅", "⚠️", "📞", "💬", "📅", "🚗", "💰", "🎉", "🤝", "👀", "❓"];

const EXAMPLES = [
  "Which deals should I chase today, and why?",
  "Quotes waiting for a signature",
  "What's overdue for me?",
  "How does our pricing compare to the competition?",
];

/**
 * The conversation. Earlier turns come from the server (each person's own, kept
 * 30 days); the assistant follows on from the last few hours of them.
 */
export default function AssistantChat({
  name,
  history = [],
  page,
  compact = false,
}: {
  name: string;
  history?: { question: string; answer: string }[];
  /** The page it was opened on (the bubble), so "this lead" means something. */
  page?: string;
  /** The bubble: no example prompts — there isn't room, and you're mid-task. */
  compact?: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => history.map((t) => ({ ...t, rows: [] })));
  const [pending, startTransition] = useTransition();
  const [hearing, setHearing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  // One attached image, already shrunk to a JPEG here. Sent with the next
  // question, then dropped — never kept in the conversation.
  const [image, setImage] = useState<{ blob: Blob; preview: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  // The question being answered and the answer so far, while it streams in.
  const [live, setLive] = useState<{ question: string; text: string } | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  const attach = async (file: Blob | null | undefined) => {
    if (!file) return;
    setImageError(null);
    const blob = await shrinkToJpeg(file, IMAGE_MAX_SIDE, MAX_IMAGE_BYTES);
    if (!blob) {
      setImageError("Couldn't read that image — try a JPG or PNG photo or screenshot.");
      return;
    }
    setImage((old) => {
      if (old) URL.revokeObjectURL(old.preview);
      return { blob, preview: URL.createObjectURL(blob) };
    });
  };
  const clearImage = () =>
    setImage((old) => {
      if (old) URL.revokeObjectURL(old.preview);
      return null;
    });

  // Drop the emoji where the cursor is, then put the cursor after it.
  const insertEmoji = (emoji: string) => {
    const el = input.current;
    const start = el?.selectionStart ?? question.length;
    const end = el?.selectionEnd ?? question.length;
    setQuestion(question.slice(0, start) + emoji + question.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  const ask = (text: string) => {
    const q = text.trim();
    if ((!q && !image) || pending) return;
    const sent = image;
    let attachment: FormData | undefined;
    if (sent) {
      attachment = new FormData();
      attachment.set("image", new File([sent.blob], "image.jpg", { type: "image/jpeg" }));
    }
    setQuestion("");
    clearImage();
    const shown = sent ? `📎 ${q || "Image"}` : q;
    setLive({ question: shown, text: "" });
    startTransition(async () => {
      // Streamed: the answer appears as it is written. If streaming isn't
      // available at all, ask the ordinary way; if it broke part-way, the server
      // still finishes and saves the answer — don't ask (and pay) twice.
      const form = new FormData();
      form.set("question", q);
      if (page) form.set("page", page);
      if (sent) form.set("image", new File([sent.blob], "image.jpg", { type: "image/jpeg" }));
      let received = false;
      const streamed = await askStreaming(form, (text) => {
        received = true;
        setLive({ question: shown, text });
      });
      const result =
        streamed ??
        (received
          ? { ok: false as const, error: "The connection dropped while I was answering — open the Ask page to see the full answer." }
          : await askCrmAction(q, page, attachment).catch(() => ({ ok: false as const, error: "Something went wrong — try again." })));
      setLive(null);
      setTurns((prev) => [
        result.ok
          ? { question: shown, answer: result.answer, rows: result.rows, learned: result.learned, actions: result.actions, choices: result.choices }
          : { question: shown, error: result.error, rows: [] },
        ...prev,
      ]);
    });
  };

  // Speak the question: transcribe, then ask it exactly as if it were typed.
  const voice = useVoiceRecorder(async (audio) => {
    setHearing(true);
    setVoiceError(null);
    const heard = await transcribeQuestion(audioForm(audio)).catch(() => ({ ok: false as const, error: "Couldn't send the recording." }));
    setHearing(false);
    if (heard.ok) ask(heard.text);
    else setVoiceError(heard.error);
  });

  // In the bubble it reads like a chat: oldest at the top, newest (and the
  // "looking into it" note) at the bottom, kept in view as the thread grows.
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (compact) end.current?.scrollIntoView({ block: "end" });
  }, [compact, turns.length, pending, live?.text]);

  const details = (turn: Turn) => (
    <>
      {/* Quick replies — only on the newest answer; older ones have been answered. */}
      {turn === turns[0] && !pending && turn.choices && turn.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {turn.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => ask(choice)}
              className="rounded-full border border-primary/40 bg-card px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary hover:text-primary-foreground"
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      {turn.actions && turn.actions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ready for you to confirm</p>
          {turn.actions.map((card) => (
            <AssistantActionCard key={card.id} card={card} />
          ))}
        </div>
      )}
      {Boolean(turn.learned) && (
        <p className="text-[11px] text-muted-foreground">
          🧠 {name} learned something from this — the workspace owner can review it in Settings → Assistant.
        </p>
      )}
      {turn.rows.length > 0 && (
        <ul className="divide-y divide-border/50 rounded-lg border border-border/50">
          {turn.rows.map((row) => (
            <li key={row.href + row.label}>
              <Link href={row.href} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{row.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
                </span>
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const composer = (
    <>
      <form
        className={compact ? "flex items-center gap-2 rounded-xl border border-border bg-card p-1.5" : "card flex items-center gap-2 p-2"}
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
        }}
      >
        {!compact && <Sparkles className="ml-2 size-4 shrink-0 text-primary" />}
        <input
          ref={input}
          className="h-10 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none"
          placeholder={compact ? `Message ${name}…` : `Ask ${name} — e.g. "What should I do with Anna?"`}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          // A pasted screenshot is attached, not typed.
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files].find((f) => f.type.startsWith("image/"));
            if (pasted) {
              event.preventDefault();
              void attach(pasted);
            }
          }}
          maxLength={500}
          aria-label="Ask the CRM"
          disabled={pending || voice.recording || hearing}
        />
        <input
          ref={picker}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            void attach(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={pending || voice.recording || hearing}
          className={`grid size-10 shrink-0 place-items-center rounded-md border ${image ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          aria-label="Attach a photo or screenshot"
          title="Attach a photo or screenshot"
        >
          <Paperclip className="size-4" />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setEmojiOpen((open) => !open)}
            disabled={pending || voice.recording || hearing}
            className="grid size-10 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            aria-label="Add an emoji"
            aria-expanded={emojiOpen}
            title="Add an emoji"
          >
            <Smile className="size-4" />
          </button>
          {emojiOpen && (
            <div className="absolute bottom-12 right-0 z-10 grid w-48 grid-cols-4 gap-1 rounded-xl border border-border bg-card p-2 shadow-lg">
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => insertEmoji(emoji)}
                  className="grid size-10 place-items-center rounded-md text-lg hover:bg-muted"
                  aria-label={`Insert ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        {voice.supported && (
          <button
            type="button"
            onClick={voice.recording ? voice.stop : voice.start}
            disabled={pending || hearing}
            className={`grid size-10 shrink-0 place-items-center rounded-md border ${voice.recording ? "border-destructive text-destructive" : "border-border text-muted-foreground hover:text-foreground"}`}
            aria-label={voice.recording ? "Stop and ask" : "Ask by voice"}
            title={voice.recording ? "Stop and ask" : "Ask by voice"}
          >
            {hearing ? <Loader2 className="size-4 animate-spin" /> : voice.recording ? <Square className="size-4" /> : <Mic className="size-4" />}
          </button>
        )}
        <button type="submit" className="btn-primary h-10 px-4 text-sm" disabled={pending || (!question.trim() && !image)}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : compact ? "Send" : "Ask"}
        </button>
      </form>
      {image && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview, never a remote image */}
          <img src={image.preview} alt="Attached image" className="size-12 rounded-md border border-border object-cover" />
          <span>Sent with your next question, then not kept.</span>
          <button type="button" onClick={clearImage} className="ml-auto inline-flex items-center gap-1 hover:text-destructive" aria-label="Remove the image">
            <X className="size-3.5" /> Remove
          </button>
        </div>
      )}
      {imageError && <p className="text-xs text-destructive">{imageError}</p>}
      {voice.recording && (
        <p className="text-xs text-destructive">● Listening… {voice.seconds}s — tap ■ when you&apos;re done.</p>
      )}
      {(voiceError || voice.error) && <p className="text-xs text-destructive">{voiceError ?? voice.error}</p>}
    </>
  );

  if (compact) {
    const thread = [...turns].reverse();
    return (
      <div className="flex min-h-full flex-col gap-3">
        {thread.length === 0 && !pending && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Hi 👋 Ask me anything about your leads, quotes, calendar or customers — type or tap the mic.
          </p>
        )}
        {thread.map((turn, index) => (
          <div key={index} className="space-y-2">
            <p className="ml-auto max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
              {turn.question}
            </p>
            <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm bg-muted/50 px-3 py-2">
              {turn.error ? (
                <p className="text-sm text-destructive">{turn.error}</p>
              ) : (
                <p className="whitespace-pre-line text-sm leading-relaxed">{turn.answer}</p>
              )}
              {details(turn)}
            </div>
          </div>
        ))}
        {pending && live && (
          <div className="space-y-2">
            <p className="ml-auto max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
              {live.question}
            </p>
            <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-muted/50 px-3 py-2">
              {live.text ? (
                <p className="whitespace-pre-line text-sm leading-relaxed">{live.text}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{name} is looking into it…</p>
              )}
            </div>
          </div>
        )}
        {pending && !live && <p className="text-sm text-muted-foreground">{name} is looking into it…</p>}
        <div className="sticky bottom-0 mt-auto space-y-1 bg-card pt-2">{composer}</div>
        <div ref={end} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {composer}

      {turns.length === 0 && !pending && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => ask(example)}
              className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <div className="card space-y-3 p-5">
          {live && <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{live.question}</p>}
          {live?.text ? (
            <p className="whitespace-pre-line text-sm leading-relaxed">{live.text}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{name} is looking into it…</p>
          )}
        </div>
      )}

      {turns.map((turn, index) => (
        <div key={turns.length - index} className="card space-y-3 p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{turn.question}</p>
          {turn.error ? (
            <p className="text-sm text-destructive">{turn.error}</p>
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed">{turn.answer}</p>
          )}
          {details(turn)}
        </div>
      ))}
    </div>
  );
}
