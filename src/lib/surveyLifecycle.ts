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
