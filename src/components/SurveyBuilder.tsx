"use client";

import { useState, useTransition } from "react";
import { saveSurvey } from "@/app/actions/surveys";
import {
  QUESTION_KINDS,
  TRIGGERS,
  blankQuestion,
  type SurveyQuestion,
} from "@/lib/surveyTypes";

type Initial = {
  id: string;
  title: string;
  intro: string;
  thankYou: string;
  active: boolean;
  trigger: string;
  questions: SurveyQuestion[];
};

export default function SurveyBuilder({ survey }: { survey: Initial }) {
  const [title, setTitle] = useState(survey.title);
  const [intro, setIntro] = useState(survey.intro);
  const [thankYou, setThankYou] = useState(survey.thankYou);
  const [active, setActive] = useState(survey.active);
  const [trigger, setTrigger] = useState(survey.trigger);
  const [questions, setQuestions] = useState<SurveyQuestion[]>(survey.questions);
  const [newKind, setNewKind] = useState<SurveyQuestion["type"]>("rating");
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function patch(i: number, next: Partial<SurveyQuestion>) {
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? ({ ...q, ...next } as SurveyQuestion) : q)));
    setSaved(false);
  }
  function remove(i: number) {
    setQuestions((qs) => qs.filter((_, idx) => idx !== i));
    setSaved(false);
  }
  function move(i: number, dir: -1 | 1) {
    setQuestions((qs) => {
      const j = i + dir;
      if (j < 0 || j >= qs.length) return qs;
      const copy = [...qs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
    setSaved(false);
  }
  function add() {
    setQuestions((qs) => [...qs, blankQuestion(newKind)]);
    setSaved(false);
  }

  function save() {
    start(async () => {
      await saveSurvey(survey.id, { title, intro, thankYou, active, trigger, questions });
      setSaved(true);
    });
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-4">
        <div>
          <label className="label">Survey name</label>
          <input
            className="input"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">When should it send?</label>
            <select
              className="input"
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value);
                setSaved(false);
              }}
            >
              {TRIGGERS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-slate-300 pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => {
                  setActive(e.target.checked);
                  setSaved(false);
                }}
                className="h-4 w-4 accent-orange-600"
              />
              Active {active ? "" : "(won't send)"}
            </label>
          </div>
        </div>
        <div>
          <label className="label">Intro message (shown on the form &amp; in the invite)</label>
          <textarea
            className="input"
            rows={2}
            value={intro}
            onChange={(e) => {
              setIntro(e.target.value);
              setSaved(false);
            }}
            placeholder="We'd love your feedback — it only takes a moment."
          />
        </div>
        <div>
          <label className="label">Thank-you message (shown after submitting)</label>
          <input
            className="input"
            value={thankYou}
            onChange={(e) => {
              setThankYou(e.target.value);
              setSaved(false);
            }}
            placeholder="Thank you! Your feedback helps us improve."
          />
        </div>
      </div>

      <div className="space-y-3">
        {questions.map((q, i) => (
          <div key={q.id} className="card space-y-3">
            <div className="flex items-start gap-2">
              <span className="badge bg-slate-800 text-slate-400 mt-1 shrink-0">{i + 1}</span>
              <input
                className="input"
                value={q.label}
                onChange={(e) => patch(i, { label: e.target.value })}
              />
              <div className="flex flex-col gap-1 shrink-0">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => move(i, 1)}
                  disabled={i === questions.length - 1}
                >
                  ↓
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pl-8">
              <span className="badge bg-orange-600/15 text-orange-300 capitalize">{q.type}</span>

              {q.type === "rating" && (
                <label className="text-xs text-slate-400 flex items-center gap-1.5">
                  Stars:
                  <select
                    className="input !w-auto !py-1"
                    value={q.scale ?? 5}
                    onChange={(e) => patch(i, { scale: Number(e.target.value) })}
                  >
                    <option value={5}>1–5</option>
                    <option value={10}>1–10</option>
                  </select>
                </label>
              )}

              {q.type === "nps" && (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <input
                    className="input !w-32 !py-1"
                    value={q.lowLabel ?? ""}
                    placeholder="Low label"
                    onChange={(e) => patch(i, { lowLabel: e.target.value })}
                  />
                  <input
                    className="input !w-32 !py-1"
                    value={q.highLabel ?? ""}
                    placeholder="High label"
                    onChange={(e) => patch(i, { highLabel: e.target.value })}
                  />
                </div>
              )}

              {q.type === "text" && (
                <label className="text-xs text-slate-400 flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-orange-600"
                    checked={!!q.long}
                    onChange={(e) => patch(i, { long: e.target.checked })}
                  />
                  Multi-line
                </label>
              )}

              {q.type !== "text" && (
                <label className="text-xs text-slate-400 flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-orange-600"
                    checked={!!q.required}
                    onChange={(e) => patch(i, { required: e.target.checked })}
                  />
                  Required
                </label>
              )}

              <button
                type="button"
                className="btn-danger btn-sm ml-auto"
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </div>

            {q.type === "choice" && (
              <div className="pl-8">
                <label className="label">Options (one per line)</label>
                <textarea
                  className="input"
                  rows={Math.max(2, q.options.length)}
                  value={q.options.join("\n")}
                  onChange={(e) =>
                    patch(i, {
                      options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                />
                <label className="text-xs text-slate-400 flex items-center gap-1.5 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-orange-600"
                    checked={!!q.multi}
                    onChange={(e) => patch(i, { multi: e.target.checked })}
                  />
                  Allow multiple selections
                </label>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input !w-auto"
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as SurveyQuestion["type"])}
        >
          {QUESTION_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn-secondary" onClick={add}>
          + Add question
        </button>
        <div className="ml-auto flex items-center gap-3">
          {saved && <span className="text-sm text-emerald-400">Saved ✓</span>}
          <button type="button" className="btn-primary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save survey"}
          </button>
        </div>
      </div>
    </div>
  );
}
