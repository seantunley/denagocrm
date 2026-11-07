/**
 * The create forms for leads and job cards open SHORT by default — the handful
 * of fields most records actually arrive with (a name and a phone number) — and
 * fold the rest behind "Add more detail". Someone who always wants the long
 * form keeps it: the choice is remembered per device, which is where that habit
 * lives.
 *
 * Pure, so the awkward cases are testable without a browser: a corrupted value,
 * a storage that throws (private windows, blocked site data), and the stage
 * default below, which has to pick correctly from a list that mixes pipelines.
 */

export type FormDetailMode = "compact" | "expanded";

export type CreateFormKey = "lead" | "jobcard";

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

/**
 * Which FormData fields each create form shows before and after the disclosure.
 * The names are the server action's contract (`createLead`, `createJobCard`):
 * the split moves fields between two parts of ONE form, it never renames or
 * drops one, and the test pins that.
 */
export const CREATE_FORM_FIELDS: Record<CreateFormKey, { compact: readonly string[]; detail: readonly string[] }> = {
  lead: {
    compact: ["contactId", "name", "phone", "email", "productId", "quantity", "source", "assignedToId"],
    // `stageId` is posted from the folded section too: the select keeps its
    // default value while hidden, so the compact form still names a stage.
    detail: ["color", "currency", "value", "stageId", "referralCode", "title", "notes"],
  },
  jobcard: {
    compact: ["vehicleId", "contactId", "description", "priority"],
    detail: ["kmIn"],
  },
};

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
 * The new-lead page lists every stage in the workspace, ordered by `order`
 * ACROSS pipelines — so "the first row" was whichever pipeline happened to own
 * an order-0 stage, and could be a closed one the server then refused. The
 * default is the first OPEN stage of the default pipeline, which is what
 * `createLead` itself falls back to when no stage is posted; failing that, the
 * first open stage anywhere; failing that, the first stage, so a required
 * select is never left empty.
 */
export function defaultEntryStageId(stages: readonly EntryStageOption[], defaultPipelineId?: string | null): string {
  const open = stages.filter((stage) => !stage.isClosed);
  const inDefault = defaultPipelineId ? open.find((stage) => stage.pipelineId === defaultPipelineId) : undefined;
  return (inDefault ?? open[0] ?? stages[0])?.id ?? "";
}
