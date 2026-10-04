"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Mic, Sparkles, Square } from "lucide-react";
import { askCrmAction } from "@/app/actions/assistant";
import { transcribeQuestion } from "@/app/actions/voice";
import type { AssistantRow } from "@/lib/crmAssistant";
import { audioForm, useVoiceRecorder } from "@/components/useVoiceRecorder";

type Turn = { question: string; answer?: string; error?: string; rows: AssistantRow[] };

const EXAMPLES = [
  "Which open leads haven't been contacted in 7 days?",
  "Quotes waiting for a signature",
  "What's overdue for me?",
  "Pipeline by stage",
];

/**
 * The conversation is kept in the browser only, for this visit: questions and
 * answers mention customers, and nothing about them needs to be stored.
 */
export default function AssistantChat() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, startTransition] = useTransition();
  const [hearing, setHearing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const ask = (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    setQuestion("");
    startTransition(async () => {
      const result = await askCrmAction(q).catch(() => ({ ok: false as const, error: "Something went wrong — try again." }));
      setTurns((prev) => [
        result.ok
          ? { question: q, answer: result.answer, rows: result.rows }
          : { question: q, error: result.error, rows: [] },
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

  return (
    <div className="space-y-5">
      <form
        className="card flex items-center gap-2 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
        }}
      >
        <Sparkles className="ml-2 size-4 shrink-0 text-primary" />
        <input
          className="h-10 flex-1 bg-transparent px-2 text-sm outline-none"
          placeholder="e.g. Hot leads over R200k that have gone quiet"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={500}
          aria-label="Ask the CRM"
          disabled={pending || voice.recording || hearing}
        />
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
        <button type="submit" className="btn-primary h-10 px-4 text-sm" disabled={pending || !question.trim()}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : "Ask"}
        </button>
      </form>
      {voice.recording && (
        <p className="text-xs text-destructive">● Listening… {voice.seconds}s — tap ■ when you&apos;re done.</p>
      )}
      {(voiceError || voice.error) && <p className="text-xs text-destructive">{voiceError ?? voice.error}</p>}

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

      {pending && <p className="text-sm text-muted-foreground">Looking through your records…</p>}

      {turns.map((turn, index) => (
        <div key={turns.length - index} className="card space-y-3 p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{turn.question}</p>
          {turn.error ? (
            <p className="text-sm text-destructive">{turn.error}</p>
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed">{turn.answer}</p>
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
        </div>
      ))}
    </div>
  );
}
