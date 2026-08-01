"use client";

import { useState } from "react";
import { submitSurveyResponse } from "@/app/actions/surveys";
import type { SurveyQuestion } from "@/lib/surveyTypes";

export default function SurveyForm({
  token,
  intro,
  thankYou,
  questions,
}: {
  token: string;
  intro: string | null;
  thankYou: string | null;
  questions: SurveyQuestion[];
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(id: string, value: unknown) {
    setAnswers((a) => ({ ...a, [id]: value }));
    setError(null);
  }

  function missingRequired(): boolean {
    for (const q of questions) {
      if (!q.required) continue;
      const a = answers[q.id];
      if (q.type === "choice" && q.multi) {
        if (!Array.isArray(a) || a.length === 0) return true;
      } else if (a === undefined || a === null || a === "") {
        return true;
      }
    }
    return false;
  }

  async function submit() {
    if (missingRequired()) {
      setError("Please answer the required questions.");
      return;
    }
    setBusy(true);
    try {
      const res = await submitSurveyResponse(token, answers);
      if (res.ok || res.error === "done") setDone(true);
      // A throttled respondent has a perfectly valid link — telling them it is
      // dead would make them give up on a survey they were willing to finish.
      else if (res.error === "rate_limited") setError("Too many attempts just now. Wait a moment and try again.");
      else setError("This survey link is no longer valid.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="text-center py-10">
        <div className="text-5xl mb-4">🎉</div>
        <h1 className="text-xl font-semibold mb-2">Thank you!</h1>
        <p className="text-slate-400">
          {thankYou || "Your feedback has been received — it really helps our team."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {intro && <p className="text-slate-300">{intro}</p>}

      {questions.map((q) => (
        <div key={q.id} className="card space-y-3">
          <p className="font-medium">
            {q.label}
            {q.required && <span className="text-orange-400"> *</span>}
          </p>

          {q.type === "rating" && (
            <Stars
              scale={q.scale ?? 5}
              value={typeof answers[q.id] === "number" ? (answers[q.id] as number) : 0}
              onPick={(n) => set(q.id, n)}
            />
          )}

          {q.type === "nps" && (
            <div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: 11 }, (_, n) => {
                  const active = answers[q.id] === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => set(q.id, n)}
                      className={`h-9 w-9 rounded-lg text-sm font-semibold transition-colors ${
                        active
                          ? "bg-orange-600 text-white"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
              {(q.lowLabel || q.highLabel) && (
                <div className="flex justify-between text-xs text-slate-500 mt-1.5">
                  <span>{q.lowLabel}</span>
                  <span>{q.highLabel}</span>
                </div>
              )}
            </div>
          )}

          {q.type === "choice" &&
            q.options.map((opt) => {
              const selected = q.multi
                ? Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(opt)
                : answers[q.id] === opt;
              return (
                <label
                  key={opt}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    selected
                      ? "border-orange-500 bg-orange-600/10"
                      : "border-slate-700 hover:border-slate-600"
                  }`}
                >
                  <input
                    type={q.multi ? "checkbox" : "radio"}
                    name={q.id}
                    className="accent-orange-600"
                    checked={selected}
                    onChange={() => {
                      if (q.multi) {
                        const cur = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
                        set(q.id, selected ? cur.filter((x) => x !== opt) : [...cur, opt]);
                      } else {
                        set(q.id, opt);
                      }
                    }}
                  />
                  <span className="text-sm">{opt}</span>
                </label>
              );
            })}

          {q.type === "text" &&
            (q.long ? (
              <textarea
                className="input"
                rows={4}
                value={(answers[q.id] as string) ?? ""}
                onChange={(e) => set(q.id, e.target.value)}
              />
            ) : (
              <input
                className="input"
                value={(answers[q.id] as string) ?? ""}
                onChange={(e) => set(q.id, e.target.value)}
              />
            ))}
        </div>
      ))}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button className="btn-primary w-full" onClick={submit} disabled={busy}>
        {busy ? "Sending…" : "Submit"}
      </button>
    </div>
  );
}

function Stars({
  scale,
  value,
  onPick,
}: {
  scale: number;
  value: number;
  onPick: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: scale }, (_, idx) => {
        const n = idx + 1;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onPick(n)}
            className={`text-3xl leading-none transition-transform hover:scale-110 ${
              n <= value ? "text-amber-400" : "text-slate-600"
            }`}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}
