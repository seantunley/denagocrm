/**
 * The lead create form opens SHORT by default — the handful of fields most
 * leads actually arrive with (a name and a phone number) — and folds the rest
 * behind "Add more detail". Someone who always wants the long
 * form keeps it: the choice is remembered per device, which is where that habit
 * lives.
 *
 * Pure, so the awkward cases are testable without a browser: a corrupted value,
 * a storage that throws (private windows, blocked site data), and the stage
 * default below, which has to pick correctly from a list that mixes pipelines.
 */

export type FormDetailMode = "compact" | "expanded";

/** Only the lead form folds. The job card's one extra field, mileage, must always be asked. */
export type CreateFormKey = "lead";

export function formDetailStorageKey(form: CreateFormKey): string {
  return `denago.create.${form}.detail`;
}

/**
 * Read the remembered mode, defaulting to COMPACT.
 *
 * Only an explicit "expanded" counts: anything absent, corrupted or thrown must
 * land on the documented default rather than quietly opening the long form.
 */
export function readFormDetailMode(
  storage: Pick<Storage, "getItem"> | null | undefined,
  form: CreateFormKey,
): FormDetailMode {
  try {
    return storage?.getItem(formDetailStorageKey(form)) === "expanded" ? "expanded" : "compact";
  } catch {
    return "compact";
  }
}

export function writeFormDetailMode(
  storage: Pick<Storage, "setItem"> | null | undefined,
  form: CreateFormKey,
  mode: FormDetailMode,
): void {
  try {
    storage?.setItem(formDetailStorageKey(form), mode);
  } catch {
    // A preference that cannot be saved resets next visit, which is survivable.
    // Failing the click would not be.
  }
}

export type EntryStageOption = {
  id: string;
  name: string;
  /** The pipeline the stage belongs to; absent on callers that list one pipeline. */
  pipelineId?: string;
  /** A won/lost stage. A lead cannot be CREATED into one, so it is never the default. */
  isClosed?: boolean;
};

/**
 * The stage a new lead lands in when nobody picks one.
 *
 * The create forms list the stages of every LIVE pipeline (`listEntryStages`)
 * — so "the first row" could belong to another pipeline, or be a closed stage
 * the server then refuses. The default is the first OPEN stage of the default
 * pipeline, which is what `createLead` itself falls back to when no stage is
 * posted; failing that, the first open stage of another live pipeline; failing
 * that, the first stage, so a required select is never left empty.
 */
export function defaultEntryStageId(stages: readonly EntryStageOption[], defaultPipelineId?: string | null): string {
  const open = stages.filter((stage) => !stage.isClosed);
  const inDefault = defaultPipelineId ? open.find((stage) => stage.pipelineId === defaultPipelineId) : undefined;
  return (inDefault ?? open[0] ?? stages[0])?.id ?? "";
}
