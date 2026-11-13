"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, FileText, Loader2, Mic, Paperclip, Smile, Square, ThumbsDown, ThumbsUp, Volume2, X } from "lucide-react";
import { rateAssistantAnswer } from "@/app/actions/assistant";
import { speakAssistantAnswer } from "@/app/actions/assistantVoice";
import type { Evidence } from "@/lib/assistantReply";
import { DaxIcon } from "@/components/DaxIcon";
import { shrinkToJpeg } from "@/components/shrinkImage";
import { ASK_STOPPED, askStreaming, newRunKey, stopAsking } from "@/components/askStream";
import { chatQueue, emptyChatQueue, type ChatItem } from "@/components/chatQueue";
import { IMAGE_MAX_SIDE, MAX_IMAGE_BYTES } from "@/lib/assistantImage";
import { transcribeQuestion } from "@/app/actions/voice";
import type { AssistantRow } from "@/lib/crmAssistant";
import { audioForm, useVoiceRecorder } from "@/components/useVoiceRecorder";
import type { ActionCard } from "@/lib/assistantActions";
import AssistantActionCard from "@/components/AssistantActionCard";
import AssistantPlanCard from "@/components/AssistantPlanCard";
import { wantsReport } from "@/lib/assistantReport";

type Turn = {
  question: string; answer?: string; cited?: string; evidence?: Evidence[]; turnId?: string;
  error?: string; rows: AssistantRow[]; learned?: number; actions?: ActionCard[]; choices?: string[]; source?: string;
  /** Stopped by the person: shown here as stopped, with nothing from it — never a card. Not in the saved history. */
  stopped?: boolean;
};

/** A scheduled answer or a fired watch arrived on its own — say so, or it reads as something you asked just now. */
const scheduledLabel = (turn: Turn) =>
  turn.source === "schedule" ? <p className="text-[11px] font-medium text-muted-foreground">⏰ Scheduled</p>
    : turn.source === "watch" ? <p className="text-[11px] font-medium text-muted-foreground">👀 Something you&apos;re watching</p>
      : turn.source === "handoff" ? <p className="text-[11px] font-medium text-muted-foreground">🙋 The chatbot handed a conversation to a person</p>
        : turn.source === "proactive" ? <p className="text-[11px] font-medium text-muted-foreground">⚡ A customer just did something</p>
          : turn.source === "brief" ? <p className="text-[11px] font-medium text-muted-foreground">☀️ Your morning brief</p>
            : turn.source === "followup" ? <p className="text-[11px] font-medium text-muted-foreground">🔁 Checking back, as I said I would</p>
              : null;

/**
 * The answer, with its evidence: each [[n]] the server numbered becomes a small
 * chip that opens the record the fact came from. Only links the server kept —
 * ones its own lookups returned — ever reach here.
 */
function AnswerText({ turn }: { turn: Turn }) {
  if (turn.stopped) return <p className="text-sm text-muted-foreground">⏹ {ASK_STOPPED}</p>;
  if (!turn.cited || !turn.evidence?.length) return <p className="whitespace-pre-line text-sm leading-relaxed">{turn.answer}</p>;
  const parts = turn.cited.split(/\[\[(\d+)\]\]/);
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed">
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const source = turn.evidence![Number(part) - 1];
        if (!source) return null;
        return (
          <Link
            key={i}
            href={source.href}
            title={`Open ${source.label}`}
            className="mx-0.5 inline-flex max-w-[12rem] items-center gap-0.5 truncate rounded-full border border-primary/30 bg-primary/5 px-1.5 align-baseline text-[11px] font-medium text-primary hover:bg-primary/10"
          >
            {source.label}
            <ArrowUpRight className="size-3 shrink-0" />
          </Link>
        );
      })}
    </p>
  );
}

const AUTO_ASKED = new Set<number>();

const WRONG_REASONS: [string, string][] = [["wrong_facts", "Wrong facts"], ["bad_advice", "Bad advice"], ["misunderstood", "Didn't understand me"], ["other", "Other"]];

/** 👍 / 👎 under an answer — and when it's wrong, why. Kept on the turn for the owner. */
function Feedback({ turnId }: { turnId: string }) {
  const [rated, setRated] = useState<"up" | "down" | "why" | null>(null);
  const rate = (rating: "up" | "down", reason?: string) => {
    setRated(rating === "down" && !reason ? "why" : rating);
    void rateAssistantAnswer(turnId, rating, reason).catch(() => undefined);
  };
  if (rated === "up" || rated === "down") return <p className="text-[11px] text-muted-foreground">Thanks — noted.</p>;
  if (rated === "why") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">What was wrong?</span>
        {WRONG_REASONS.map(([key, label]) => (
          <button key={key} type="button" onClick={() => rate("down", key)} className="rounded-full border border-border px-2 py-0.5 hover:border-primary">
            {label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      <button type="button" onClick={() => rate("up")} className="rounded p-1 hover:text-foreground" aria-label="Useful" title="Useful">
        <ThumbsUp className="size-3.5" />
      </button>
      <button type="button" onClick={() => rate("down")} className="rounded p-1 hover:text-foreground" aria-label="Wrong" title="Wrong">
        <ThumbsDown className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * 📄 PDF — shown only when the question asked for a report or a PDF. This answer as a formatted report, with the business's name and logo
 * in its header (app/api/pdf/assistant-report). A plain link, opened in a new
 * tab: the server checks the answer is this person's own, and nothing is looked
 * up again to make it.
 */
function ReportLink({ turnId }: { turnId: string }) {
  return (
    <a
      href={`/api/pdf/assistant-report/${encodeURIComponent(turnId)}`}
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-1 rounded p-1 text-xs text-muted-foreground hover:text-foreground"
      title="Download this answer as a PDF report"
    >
      <FileText className="size-3.5" aria-hidden />
      PDF
    </a>
  );
}

// Set once the server says listening is off in this workspace (owner switch,
// no voice set up, module off): every Listen button then hides for the page's life.
let listeningOff = false;

/**
 * 🔊 Listen — this answer read aloud. Made only on the click (each one costs
 * ElevenLabs credit) and played from memory; nothing is kept.
 */
function Listen({ turnId }: { turnId: string }) {
  const [state, setState] = useState<{ busy?: boolean; audio?: string; error?: string; off?: boolean }>({});
  if (state.audio) return <audio src={state.audio} controls autoPlay className="h-8 w-full max-w-xs" />;
  if (state.off) return <p className="text-[11px] text-muted-foreground">{state.error}</p>;
  if (listeningOff) return null;
  const listen = async () => {
    setState({ busy: true });
    const result = await speakAssistantAnswer(turnId).catch(() => ({ ok: false as const, error: "Couldn't reach the server — try again.", off: false }));
    if (result.ok) return setState({ audio: result.audio });
    if (result.off) listeningOff = true;
    setState({ error: result.error, off: result.off });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <button type="button" onClick={listen} disabled={state.busy} className="inline-flex items-center gap-1 rounded p-1 hover:text-foreground" title="Read this answer aloud">
        {state.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Volume2 className="size-3.5" />}
        Listen
      </button>
      {state.error && <span>{state.error}</span>}
    </div>
  );
}

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
  autoAsk,
  listen = false,
}: {
  name: string;
  history?: { question: string; answer: string; source?: string }[];
  /** The page it was opened on (the bubble), so "this lead" means something. */
  page?: string;
  /** The bubble: no example prompts — there isn't room, and you're mid-task. */
  compact?: boolean;
  /** Asked once as soon as the chat opens (the home page's "Ask DAX for a plan"). */
  autoAsk?: { question: string; key: number };
  /** The owner switched voice replies on and a voice is set up: show 🔊 Listen. */
  listen?: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => history.map((t) => ({ ...t, rows: [] })));
  // One answer at a time; anything asked meanwhile waits its turn, and can be edited or removed (chatQueue).
  const [chat, dispatch] = useReducer(chatQueue<Blob>, undefined, emptyChatQueue<Blob>);
  const pending = chat.running !== null;
  // Said out loud to a screen reader, and shown: queued, stopped, too late to stop.
  const [notice, setNotice] = useState<string | null>(null);
  // The question being answered: its run key (what Stop names) and the switch that stops reading it.
  const flight = useRef<{ key: string; stopper: AbortController; item: ChatItem<Blob> } | null>(null);
  const started = useRef(new Set<number>());
  const [hearing, setHearing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  // One attached image, already shrunk to a JPEG here. Sent with the next
  // question, then dropped — never kept in the conversation.
  const [image, setImage] = useState<{ blob: Blob; preview: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  // The question being answered and the answer so far, while it streams in.
  // While asking: the answer so far, or — before it starts — what it is doing.
  const [live, setLive] = useState<{ question: string; text: string; status?: string } | null>(null);
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

  // Asking while an answer is still coming QUEUES it: it goes, on its own, when that one is done.
  const ask = (text: string) => {
    const q = text.trim();
    if (!q && !image) return;
    setNotice(pending ? `Queued — it goes as soon as ${name} is done.` : null);
    dispatch({ type: "ask", text: q, image: image?.blob ?? null });
    setQuestion("");
    clearImage();
  };

  const run = async (item: ChatItem<Blob>) => {
    const q = item.text;
    const sent = item.image;
    const shown = sent ? `📎 ${q || "Image"}` : q;
    setLive({ question: shown, text: "" });
    // Streamed: the answer appears as it is written. Asked exactly once — a
    // dropped stream is never re-asked another way (askStream).
    const form = new FormData();
    form.set("question", q);
    // The query too (?conversation=…, ?edit=…): on the inbox and the quote
    // editor, that is what says which record "this" is.
    if (page) form.set("page", `${page}${typeof window === "undefined" ? "" : window.location.search}`);
    if (sent) form.set("image", new File([sent], "image.jpg", { type: "image/jpeg" }));
    const key = newRunKey();
    const stopper = new AbortController();
    flight.current = { key, stopper, item };
    const result = await askStreaming(
      form,
      (text) => setLive({ question: shown, text }),
      (status) => setLive((prev) => ({ question: shown, text: prev?.text ?? "", status })),
      { key, signal: stopper.signal },
    );
    flight.current = null;
    setLive(null);
    // Stopped: kept on screen as stopped, with nothing from it (the server kept nothing either) — never a card.
    const stopped = stopper.signal.aborted;
    setTurns((prev) => [
      stopped
        ? { question: shown, stopped: true, rows: [] }
        : result.ok
          ? {
              question: shown, answer: result.answer, cited: result.cited, evidence: result.evidence, turnId: result.turnId,
              rows: result.rows, learned: result.learned, actions: result.actions, choices: result.choices,
            }
          : { question: shown, error: result.error, rows: [] },
      ...prev,
    ]);
    dispatch({ type: "finished", id: item.id });
  };

  // The next question goes as soon as there is one and nothing is being answered — once each.
  useEffect(() => {
    const item = chat.running;
    if (!item || started.current.has(item.id)) return;
    started.current.add(item.id);
    void run(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per question
  }, [chat.running]);

  // STOP AND CORRECT. The server decides: stopped (nothing from it is kept, and the next queued question goes) or
  // too late (it had finished — its answer arrives as usual). Stopped with nothing queued or typed, the question
  // comes back into the box to be put right.
  const stop = async () => {
    const current = flight.current;
    if (!current || chat.stopping) return;
    dispatch({ type: "stopping" });
    if (!(await stopAsking(current.key))) {
      dispatch({ type: "stopRefused" });
      setNotice(`Too late to stop — ${name} had already finished.`);
      return;
    }
    current.stopper.abort();
    const putBack = chat.queue.length === 0 && !question.trim() && !image;
    if (putBack) {
      setQuestion(current.item.text);
      if (current.item.image) setImage({ blob: current.item.image, preview: URL.createObjectURL(current.item.image) });
      input.current?.focus();
    }
    setNotice(putBack ? "Stopped. Your question is back in the box — fix it and send." : "Stopped — nothing from that answer was kept.");
  };

  // A queued question taken back into the box to edit (anything already typed stays, before it).
  const editQueued = (item: ChatItem<Blob>) => {
    dispatch({ type: "remove", id: item.id });
    setQuestion((prev) => (prev.trim() ? `${prev.trim()} ${item.text}` : item.text));
    if (item.image) {
      const preview = URL.createObjectURL(item.image);
      setImage((old) => {
        if (old) URL.revokeObjectURL(old.preview);
        return { blob: item.image!, preview };
      });
    }
    input.current?.focus();
  };

  // Asked once when opened for it (the brief's "Ask DAX for a plan"). Keys are
  // remembered for the page's life, so a remount — moving to another page with
  // the bubble open, or React's dev double effect — never asks it again.
  useEffect(() => {
    if (!autoAsk || AUTO_ASKED.has(autoAsk.key)) return;
    AUTO_ASKED.add(autoAsk.key);
    // An outside trigger (the brief's button), acted on once per key — the
    // same as the person pressing Ask, which is what it stands for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    ask(autoAsk.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per key
  }, [autoAsk?.key]);

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
  }, [compact, turns.length, pending, live?.text, chat.queue.length]);

  const stopButton = (
    <button
      type="button"
      onClick={() => void stop()}
      disabled={chat.stopping}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:border-destructive hover:text-destructive disabled:opacity-60"
      aria-label={`Stop ${name}'s answer`}
      title="Stop — nothing from this answer is kept"
    >
      {chat.stopping ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
      {chat.stopping ? "Stopping…" : "Stop"}
    </button>
  );

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
            card.kind === "plan" ? <AssistantPlanCard key={card.id} plan={card.plan} /> : <AssistantActionCard key={card.id} card={card} />
          ))}
        </div>
      )}
      {turn.turnId && <Feedback turnId={turn.turnId} />}
      {/* Only under an answer to "a report on…" / "a PDF of…": never on every reply. */}
      {turn.turnId && turn.answer && !turn.stopped && wantsReport(turn.question) && <ReportLink turnId={turn.turnId} />}
      {listen && turn.turnId && <Listen turnId={turn.turnId} />}
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
        {!compact && <DaxIcon className="ml-2 size-4 shrink-0 text-primary" />}
        <input
          ref={input}
          className="h-10 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none"
          placeholder={pending ? `Type your next message — it goes when ${name} is done` : compact ? `Message ${name}…` : `Ask ${name} — e.g. "What should I do with Anna?"`}
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
          disabled={voice.recording || hearing}
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
          disabled={voice.recording || hearing}
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
            disabled={voice.recording || hearing}
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
            disabled={hearing}
            className={`grid size-10 shrink-0 place-items-center rounded-md border ${voice.recording ? "border-destructive text-destructive" : "border-border text-muted-foreground hover:text-foreground"}`}
            aria-label={voice.recording ? "Stop and ask" : "Ask by voice"}
            title={voice.recording ? "Stop and ask" : "Ask by voice"}
          >
            {hearing ? <Loader2 className="size-4 animate-spin" /> : voice.recording ? <Square className="size-4" /> : <Mic className="size-4" />}
          </button>
        )}
        <button type="submit" className="btn-primary h-10 px-4 text-sm" disabled={!question.trim() && !image} title={pending ? `Goes as soon as ${name} is done` : undefined}>
          {pending ? "Queue" : compact ? "Send" : "Ask"}
        </button>
      </form>
      {chat.queue.length > 0 && (
        <ol className="space-y-1" aria-label="Waiting to send">
          {chat.queue.map((item) => (
            <li key={item.id} className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-card px-3 py-1 text-sm">
              <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Queued</span>
              <span className="min-w-0 flex-1 truncate">{item.image ? `📎 ${item.text || "Image"}` : item.text}</span>
              <button type="button" onClick={() => editQueued(item)} className="h-9 shrink-0 rounded-md px-2 text-xs font-medium text-primary hover:bg-muted" aria-label={`Edit queued message: ${item.text || "image"}`}>
                Edit
              </button>
              <button type="button" onClick={() => dispatch({ type: "remove", id: item.id })} className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-destructive" aria-label={`Remove queued message: ${item.text || "image"}`}>
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ol>
      )}
      <p aria-live="polite" className={notice ? "text-xs text-muted-foreground" : "sr-only"}>{notice}</p>
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
            {scheduledLabel(turn)}
            <p className="ml-auto max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
              {turn.question}
            </p>
            <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm bg-muted/50 px-3 py-2">
              {turn.error ? (
                <p className="text-sm text-destructive">{turn.error}</p>
              ) : (
                <AnswerText turn={turn} />
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
            <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm bg-muted/50 px-3 py-2">
              {live.text ? (
                <p className="whitespace-pre-line text-sm leading-relaxed">{live.text}</p>
              ) : (
                <p className="animate-pulse text-sm text-muted-foreground">{live.status ?? `${name} is looking into it…`}</p>
              )}
              {stopButton}
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
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{live?.question}</p>
            {stopButton}
          </div>
          {live?.text ? (
            <p className="whitespace-pre-line text-sm leading-relaxed">{live.text}</p>
          ) : (
            <p className="animate-pulse text-sm text-muted-foreground">{live?.status ?? `${name} is looking into it…`}</p>
          )}
        </div>
      )}

      {turns.map((turn, index) => (
        <div key={turns.length - index} className="card space-y-3 p-5">
          {scheduledLabel(turn)}
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{turn.question}</p>
          {turn.error ? (
            <p className="text-sm text-destructive">{turn.error}</p>
          ) : (
            <AnswerText turn={turn} />
          )}
          {details(turn)}
        </div>
      ))}
    </div>
  );
}
