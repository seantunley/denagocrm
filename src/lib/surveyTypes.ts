// Pure survey types + metadata. NO server imports — safe to use in client
// components (the builder and the public form both import from here).

export type SurveyQuestion =
  | { id: string; type: "rating"; label: string; required?: boolean; scale?: number }
  | {
      id: string;
      type: "nps";
      label: string;
      required?: boolean;
      lowLabel?: string;
      highLabel?: string;
    }
  | { id: string; type: "choice"; label: string; required?: boolean; options: string[]; multi?: boolean }
  | { id: string; type: "text"; label: string; required?: boolean; long?: boolean };

export type SurveyType = "csat" | "sales" | "nps" | "adhoc";

export const SURVEY_TYPES: {
  id: SurveyType;
  label: string;
  short: string;
  desc: string;
  trigger: string | null;
}[] = [
  {
    id: "csat",
    label: "Service satisfaction (CSAT)",
    short: "CSAT",
    desc: "Auto-sends after a job card is completed.",
    trigger: "job_complete",
  },
  {
    id: "sales",
    label: "Sales / delivery experience",
    short: "Sales",
    desc: "Auto-sends after a delivery or a won deal.",
    trigger: "delivery",
  },
  {
    id: "nps",
    label: "Net Promoter Score (NPS)",
    short: "NPS",
    desc: "Gauge loyalty — send periodically to your customers.",
    trigger: null,
  },
  {
    id: "adhoc",
    label: "Ad-hoc survey",
    short: "Ad-hoc",
    desc: "Build anything and send to a chosen audience.",
    trigger: null,
  },
];

export function surveyTypeLabel(type: string): string {
  return SURVEY_TYPES.find((t) => t.id === type)?.short ?? type;
}

// Manual = no trigger. The rest auto-send at a natural completion moment.
export const TRIGGERS: { id: string; label: string }[] = [
  { id: "", label: "Manual only — I'll send it myself" },
  { id: "job_complete", label: "Automatically when a job card is completed" },
  { id: "delivery", label: "Automatically when a cart is delivered" },
  { id: "won", label: "Automatically when a deal is won" },
];

export const QUESTION_KINDS: { id: SurveyQuestion["type"]; label: string }[] = [
  { id: "rating", label: "Star rating (1–5)" },
  { id: "nps", label: "NPS (0–10)" },
  { id: "choice", label: "Multiple choice" },
  { id: "text", label: "Comment / text" },
];

/** NPS = % promoters (9–10) − % detractors (0–6). Null when no scores. */
export function npsFromScores(scores: number[]): number | null {
  if (!scores.length) return null;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return Math.round(((promoters - detractors) / scores.length) * 100);
}

let qc = 0;
export function newQuestionId(): string {
  qc += 1;
  return `q${Date.now().toString(36)}${qc.toString(36)}`;
}

export function blankQuestion(type: SurveyQuestion["type"]): SurveyQuestion {
  const id = newQuestionId();
  switch (type) {
    case "rating":
      return { id, type, label: "How would you rate…?", required: true, scale: 5 };
    case "nps":
      return {
        id,
        type,
        label: "How likely are you to recommend us?",
        required: true,
        lowLabel: "Not likely",
        highLabel: "Very likely",
      };
    case "choice":
      return { id, type, label: "Pick one", required: true, options: ["Option 1", "Option 2"] };
    default:
      return { id, type, label: "Your comments", long: true };
  }
}

export function defaultQuestions(type: SurveyType): SurveyQuestion[] {
  switch (type) {
    case "csat":
      return [
        {
          id: newQuestionId(),
          type: "rating",
          label: "How would you rate the service you received?",
          required: true,
          scale: 5,
        },
        { id: newQuestionId(), type: "text", label: "Anything we could have done better?", long: true },
      ];
    case "sales":
      return [
        {
          id: newQuestionId(),
          type: "rating",
          label: "How was your buying experience with Denago?",
          required: true,
          scale: 5,
        },
        { id: newQuestionId(), type: "text", label: "Any comments for the team?", long: true },
      ];
    case "nps":
      return [
        {
          id: newQuestionId(),
          type: "nps",
          label: "How likely are you to recommend Denago to a friend or colleague?",
          required: true,
          lowLabel: "Not likely",
          highLabel: "Very likely",
        },
        { id: newQuestionId(), type: "text", label: "What's the main reason for your score?", long: true },
      ];
    default:
      return [
        { id: newQuestionId(), type: "rating", label: "Your question here", required: true, scale: 5 },
      ];
  }
}

export function defaultIntro(type: SurveyType): string {
  switch (type) {
    case "csat":
      return "Thanks for choosing Denago Cape Town. We'd love to know how we did on your recent service.";
    case "sales":
      return "Congratulations on your new Denago! We'd love to hear about your buying experience.";
    case "nps":
      return "We're always trying to improve. Could you spare a moment to answer one quick question?";
    default:
      return "We'd love your feedback — it only takes a moment.";
  }
}
