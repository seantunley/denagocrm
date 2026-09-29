export const SURVEY_STATUSES = ["draft", "in_review", "changes_requested", "approved", "published", "inactive", "archived"] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

const TRANSITIONS: Record<SurveyStatus, readonly SurveyStatus[]> = {
  draft: ["in_review", "archived"],
  in_review: ["approved", "changes_requested", "draft"],
  changes_requested: ["draft", "in_review"],
  approved: ["published", "draft"],
  published: ["inactive", "archived"],
  inactive: ["archived"],
  archived: [],
};

export function isSurveyStatus(value: string): value is SurveyStatus {
  return (SURVEY_STATUSES as readonly string[]).includes(value);
}

export function assertSurveyTransition(from: string, to: string) {
  if (!isSurveyStatus(from) || !isSurveyStatus(to)) throw new Error("Unknown survey status");
  if (!TRANSITIONS[from].includes(to)) throw new Error(`Invalid survey transition: ${from} -> ${to}`);
}

/**
 * ARMED: this survey will email a customer BY ITSELF, with nobody pressing send.
 *
 * Four conditions have to line up, and until now no screen asked all four
 * together. The surveys list showed the trigger ("Automatically when a cart is
 * delivered") for any survey that had one CONFIGURED — a draft and a live
 * survey rendered identically — and the editor's auto-send note did the same.
 * So a test survey published in July sat in the list looking exactly like a
 * draft, fired on the next delivery, emailed a customer, and reminded them 48
 * hours later. The first anyone knew was the customer's copy.
 *
 * These are the SAME four conditions the automation itself checks before it
 * sends (lib/governedSurveyRuntime.ts — status/active/deletedAt/trigger), and
 * that is the point: one predicate, asked by both the thing that sends and the
 * screens that claim what will be sent, so the badge cannot drift from the
 * behaviour. If the runtime query changes, this moves with it.
 */
export function isSurveyArmed(survey: {
  status: string;
  active: boolean;
  trigger: string | null;
  deletedAt?: Date | null;
}): boolean {
  return (
    Boolean(survey.trigger) &&
    survey.status === "published" &&
    survey.active === true &&
    !survey.deletedAt
  );
}

/**
 * Why a survey with a trigger configured is NOT going to send.
 *
 * Null when it has no trigger (nothing to explain) or when it is armed. The
 * distinction this draws is the one the list was missing: "set up to auto-send"
 * and "auto-sending right now" are different states and used to look the same.
 */
export function surveyDormantReason(survey: {
  status: string;
  active: boolean;
  trigger: string | null;
  deletedAt?: Date | null;
}): string | null {
  if (!survey.trigger) return null;
  if (isSurveyArmed(survey)) return null;
  if (survey.deletedAt) return "deleted";
  if (survey.status !== "published") return `not published (${survey.status.replaceAll("_", " ")})`;
  return "deactivated";
}

/** What each trigger fires on, as a phrase that completes "… automatically X". */
const TRIGGER_PHRASE: Record<string, string> = {
  job_complete: "when a job card is completed",
  delivery: "when a cart is delivered",
  won: "when a deal is won",
};

/**
 * What the editor tells you this survey does on its own.
 *
 * Lives HERE, beside the predicate it depends on, rather than inside the page:
 * as a page-local function it could not be imported, so the only thing a test
 * could check was that the source mentioned the right identifiers — and a
 * mutation that made the dormant branch permanently unreachable passed. A rule
 * about what we claim to customers deserves to be executed by its test.
 *
 * Returns undefined when there is nothing automatic to say.
 */
export function surveyAutoSendNote(survey: {
  status: string;
  active: boolean;
  trigger: string | null;
  deletedAt?: Date | null;
  delayHours: number;
}): string | undefined {
  if (!survey.trigger) return undefined;
  const when = TRIGGER_PHRASE[survey.trigger];
  if (!when) return undefined;

  const dormant = surveyDormantReason(survey);
  if (dormant) {
    return `Set up to email customers automatically ${when} — but it is not sending: ${dormant}.`;
  }

  const hours = survey.delayHours;
  const delay =
    hours > 0
      ? ` It waits ${
          hours % 24 === 0
            ? `${hours / 24} day${hours / 24 === 1 ? "" : "s"}`
            : `${hours} hour${hours === 1 ? "" : "s"}`
        } after the event before sending.`
      : "";
  return `⚠ LIVE: this emails customers automatically ${when}, with nobody pressing send.${delay}`;
}

export function validateSurveyQuestions(questions: unknown[]) {
  const errors: string[] = [];
  if (questions.length === 0) errors.push("Add at least one question");
  if (questions.length > 100) errors.push("A survey may contain at most 100 questions");
  const ids = new Set<string>();
  for (const item of questions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("Invalid question");
      continue;
    }
    const question = item as Record<string, unknown>;
    const id = String(question.id ?? "").trim();
    const label = String(question.label ?? "").trim();
    const type = String(question.type ?? "").trim();
    if (!id || ids.has(id)) errors.push("Every question needs a unique ID");
    if (id) ids.add(id);
    if (!label) errors.push(`Question ${id || "without ID"} needs a label`);
    if (!new Set(["nps", "rating", "text", "choice"]).has(type)) errors.push(`Unsupported question type: ${type || "blank"}`);

    if (type === "choice") {
      const options = Array.isArray(question.options)
        ? question.options.map((option) => String(option).trim()).filter(Boolean)
        : [];
      if (options.length < 2) errors.push(`Choice question ${id || "without ID"} needs at least two options`);
      if (new Set(options).size !== options.length) errors.push(`Choice question ${id || "without ID"} has duplicate options`);
      if (options.length > 50) errors.push(`Choice question ${id || "without ID"} has too many options`);
    }
    if (type === "rating") {
      const scale = Number(question.scale ?? 5);
      if (!Number.isInteger(scale) || scale < 2 || scale > 10) errors.push(`Rating question ${id || "without ID"} needs a scale from 2 to 10`);
    }
  }
  return [...new Set(errors)];
}
