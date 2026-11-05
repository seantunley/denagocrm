/**
 * The Journey canvas (components/JourneyCanvas) over the builder's OWN step list. No server code: it runs in the browser.
 *
 * The canvas is a view and an editor of the same `BuilderStep[]` the list editor edits, and saving still goes through
 * builderDefinition — so the canvas cannot save a format of its own. Every edit here is a tree operation on that list:
 *
 *  - a wire is ORDER. A step's out-wire goes to the step below it in the same list; a Choose has one wire per branch to
 *    the branch's first step; a Repeat has one to its loop's first step.
 *  - CONNECTING a wire from handle H to step S moves S to where H points: right after H's step, or first in H's branch.
 *    Reconnecting a wire's end is the same move. Nothing else can be expressed, because nothing else can be saved.
 *  - a condition's "No" wire is drawn (to its stop, or to the target it was written with) but is not an edit point.
 */
import { JOURNEY_LIMITS, JOURNEY_STEP_LABELS, type JourneyStepType } from "./journeyTypes";
import { conditionHasOwnTargets, generatedStopId, initialConfig, isRecord, type BuilderStep } from "./journeyBuilderDefinition";

/** Where a list of steps lives: the journey itself (null), or one slot of a Choose/Repeat. */
export type ListRef = { parentId: string; slot: string } | null;
export type Located = { step: BuilderStep; list: ListRef; index: number; depth: number };

export const START_NODE = "__start";
const stopNode = (conditionId: string) => `__stop:${conditionId}`;

/** A container's step lists, in the order the canvas shows them. Slots: `option:<i>`, `default`, `sequence`. */
export function slotsOf(step: BuilderStep): { slot: string; label: string; steps: BuilderStep[] }[] {
  const { config } = step;
  if (step.type === "choose") {
    const options = Array.isArray(config.options) ? config.options : [];
    const out = options.flatMap((option, i) =>
      isRecord(option) && Array.isArray(option.sequence) ? [{ slot: `option:${i}`, label: `Branch ${i + 1}`, steps: option.sequence as BuilderStep[] }] : [],
    );
    if (Array.isArray(config.default)) out.push({ slot: "default", label: "Otherwise", steps: config.default as BuilderStep[] });
    return out;
  }
  if (step.type === "repeat" && Array.isArray(config.sequence)) return [{ slot: "sequence", label: "Each round", steps: config.sequence as BuilderStep[] }];
  return [];
}

function withSlot(step: BuilderStep, slot: string, steps: BuilderStep[]): BuilderStep {
  if (slot.startsWith("option:")) {
    const at = Number(slot.slice(7));
    const options = Array.isArray(step.config.options) ? step.config.options : [];
    return { ...step, config: { ...step.config, options: options.map((o, i) => (i === at && isRecord(o) ? { ...o, sequence: steps } : o)) } };
  }
  return { ...step, config: { ...step.config, [slot]: steps } };
}

export function locate(steps: BuilderStep[], id: string, list: ListRef = null, depth = 0): Located | null {
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step)) continue;
    if (step.id === id) return { step, list, index, depth };
    for (const slot of slotsOf(step)) {
      const found = locate(slot.steps, id, { parentId: step.id, slot: slot.slot }, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function listAt(steps: BuilderStep[], list: ListRef): BuilderStep[] | null {
  if (!list) return steps;
  const parent = locate(steps, list.parentId);
  return parent ? slotsOf(parent.step).find((s) => s.slot === list.slot)?.steps ?? null : null;
}

/** The whole journey with one list replaced — the container that holds it is rebuilt, and so on up. */
function replaceList(steps: BuilderStep[], list: ListRef, next: BuilderStep[]): BuilderStep[] {
  if (!list) return next;
  const parent = locate(steps, list.parentId)!;
  const siblings = listAt(steps, parent.list)!;
  return replaceList(steps, parent.list, siblings.map((s, i) => (i === parent.index ? withSlot(s, list.slot, next) : s)));
}

export function updateStep(steps: BuilderStep[], id: string, next: BuilderStep): BuilderStep[] {
  const at = locate(steps, id);
  if (!at) return steps;
  return replaceList(steps, at.list, listAt(steps, at.list)!.map((s, i) => (i === at.index ? next : s)));
}

export function insertStep(steps: BuilderStep[], list: ListRef, index: number, step: BuilderStep): BuilderStep[] {
  const target = listAt(steps, list);
  if (!target) return steps;
  return replaceList(steps, list, [...target.slice(0, index), step, ...target.slice(index)]);
}

/** A string is the reason it was refused. A branch or loop may not be emptied: the parser refuses an empty sequence. */
export function removeStep(steps: BuilderStep[], id: string): BuilderStep[] | string {
  const at = locate(steps, id);
  if (!at) return steps;
  const list = listAt(steps, at.list)!;
  if (at.list && list.length === 1) return "A branch needs at least one step";
  return replaceList(steps, at.list, list.filter((_, i) => i !== at.index));
}

/** How many container levels a step brings with it (0 for a plain step). */
function nesting(step: BuilderStep): number {
  const slots = slotsOf(step);
  return slots.length || step.type === "choose" || step.type === "repeat"
    ? 1 + Math.max(0, ...slots.flatMap((s) => s.steps.filter(isRecord).map(nesting)))
    : 0;
}

/** Move a step (with everything inside it) to `index` of `list` — the position BEFORE the move, as the canvas saw it. */
export function moveStep(steps: BuilderStep[], id: string, list: ListRef, index: number): BuilderStep[] | string {
  const from = locate(steps, id);
  const target = listAt(steps, list);
  if (!from || !target) return steps;
  if (list && (list.parentId === id || locate(slotsOf(from.step).flatMap((s) => s.steps), list.parentId))) {
    return "A step can't go inside itself";
  }
  const sameList = (list?.parentId ?? null) === (from.list?.parentId ?? null) && (list?.slot ?? null) === (from.list?.slot ?? null);
  if (sameList && (index === from.index || index === from.index + 1)) return steps;
  if (!sameList && from.list && listAt(steps, from.list)!.length === 1) return "A branch needs at least one step";
  const depth = list ? locate(steps, list.parentId)!.depth + 1 : 0;
  const levels = nesting(from.step);
  // The list editor's own rule (JourneyBuilder's type picker): a container needs depth + 1 below the parser's limit.
  if (levels && depth + levels >= JOURNEY_LIMITS.depth) return `Steps can only nest ${JOURNEY_LIMITS.depth - 1} levels deep`;

  const removed = removeStep(steps, id) as BuilderStep[];
  return insertStep(removed, list, sameList && from.index < index ? index - 1 : index, from.step);
}

/** Where a wire from this handle leads to: the step after `nodeId`, or the first step of one of its branches. */
export function insertionPoint(steps: BuilderStep[], nodeId: string, handle: string | null | undefined): { list: ListRef; index: number } | null {
  if (nodeId === START_NODE) return { list: null, index: 0 };
  const at = locate(steps, nodeId);
  if (!at) return null;
  if (handle === "out" || handle === "yes") return { list: at.list, index: at.index + 1 };
  if (handle && slotsOf(at.step).some((s) => s.slot === handle)) return { list: { parentId: nodeId, slot: handle }, index: 0 };
  return null;
}

/** A wire drawn (or re-drawn) from `source`'s `handle` to `target`: `target` moves there. */
export function connectSteps(steps: BuilderStep[], source: string, handle: string | null | undefined, target: string): BuilderStep[] | string {
  const point = insertionPoint(steps, source, handle);
  if (!point || !locate(steps, target)) return "Steps run in order — connect a step's output to the step that should come next";
  return moveStep(steps, target, point.list, point.index);
}

/* ── the picture ─────────────────────────────────────────────────────────── */

export type CanvasHandle = { id: string; label: string; tone?: "yes" | "no" };
export type CanvasNode =
  | { id: string; kind: "start"; x: number; y: number }
  | { id: string; kind: "stop"; x: number; y: number; label: string }
  | { id: string; kind: "step"; x: number; y: number; step: BuilderStep; depth: number; handles: CanvasHandle[] };
export type CanvasEdge = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  label?: string;
  kind: "next" | "yes" | "no" | "branch" | "rejoin" | "loop";
  /** Its end can be dragged to another step (a move). False for the wires that are drawn, not edited. */
  editable: boolean;
};

export const CANVAS_COLUMN = 300;
const GAP = 40;
/** Roughly a card's height — the layout only needs it to keep branches clear of the card above them. */
const cardHeight = (handles: number) => 104 + 26 * handles;

/** A condition at the top level written with its own jump targets (journeyBuilderDefinition keeps them). */
export function hasOwnTargets(step: BuilderStep, depth: number): boolean {
  return depth === 0 && conditionHasOwnTargets(step);
}

export function stepHandles(step: BuilderStep): CanvasHandle[] {
  if (step.type === "condition") return [{ id: "yes", label: "Yes", tone: "yes" }, { id: "no", label: "No", tone: "no" }];
  const slots = slotsOf(step).map((s) => ({ id: s.slot, label: s.label }));
  if (step.type === "choose") return [...slots, { id: "out", label: "Afterwards" }];
  if (step.type === "repeat") return [...slots, { id: "out", label: "When done" }];
  return [{ id: "out", label: "" }];
}

/**
 * Every step (at any depth) as a card, laid out left to right in running order; a container's branches are stacked
 * below it, one band each, one column to its right; the step after a container sits after its longest branch.
 */
export function journeyGraph(steps: BuilderStep[]): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = [{ id: START_NODE, kind: "start", x: 0, y: 0 }];
  const edges: CanvasEdge[] = [];
  const edge = (source: string, sourceHandle: string, target: string, kind: CanvasEdge["kind"], label?: string, editable = true) =>
    edges.push({ id: `${source}:${sourceHandle}>${target}`, source, sourceHandle, target, kind, label, editable });
  const outOf = (step: BuilderStep) => (step.type === "condition" ? "yes" : "out");

  const layout = (list: BuilderStep[], x: number, y: number, depth: number): { right: number; bottom: number } => {
    let cx = x;
    let bottom = y;
    list.forEach((step, index) => {
      if (!isRecord(step)) return;
      const handles = stepHandles(step);
      nodes.push({ id: step.id, kind: "step", x: cx, y, step, depth, handles });
      let stepBottom = y + cardHeight(handles.length);
      let right = cx + CANVAS_COLUMN;
      const next = list[index + 1];

      if (step.type === "condition") {
        const own = hasOwnTargets(step, depth);
        if (!own || step.config.falseStepId === generatedStopId(step.id)) {
          nodes.push({ id: stopNode(step.id), kind: "stop", x: cx + 40, y: stepBottom + 30, label: depth ? "Run stops here" : "Stop" });
          edge(step.id, "no", stopNode(step.id), "no", "No", false);
          stepBottom += 30 + 60;
        } else {
          const no = String(step.config.falseStepId || next?.id || "");
          if (no) edge(step.id, "no", no, "no", "No", false);
        }
        if (own) {
          const yes = String(step.config.trueStepId || next?.id || "");
          if (yes) edge(step.id, "yes", yes, "yes", "Yes", false);
        } else if (next) {
          edge(step.id, "yes", next.id, "yes", "Yes");
        }
      } else if (next) {
        edge(step.id, "out", next.id, "next", step.type === "choose" ? "afterwards" : step.type === "repeat" ? "when done" : undefined);
      }

      let by = stepBottom + GAP;
      for (const slot of slotsOf(step)) {
        const first = slot.steps.find(isRecord);
        if (!first) continue;
        edge(step.id, slot.slot, first.id, "branch", slot.label);
        const band = layout(slot.steps, cx + CANVAS_COLUMN, by, depth + 1);
        const last = slot.steps.filter(isRecord).at(-1)!;
        // The end of a branch carries on after the Choose; the end of a loop goes round again.
        if (step.type === "repeat") edge(last.id, outOf(last), step.id, "loop", "next round", false);
        else if (next) edge(last.id, outOf(last), next.id, "rejoin", undefined, false);
        right = Math.max(right, band.right);
        by = band.bottom + GAP;
      }
      if (slotsOf(step).length) stepBottom = by - GAP;
      bottom = Math.max(bottom, stepBottom);
      cx = right;
    });
    return { right: cx, bottom };
  };

  const first = steps.find(isRecord);
  if (first) edge(START_NODE, "out", first.id, "next");
  layout(steps, CANVAS_COLUMN, 0, 0);
  return { nodes, edges };
}

/** One line on a card. Only what an author recognises their step by; the inspector has the rest. */
export function stepSummary(step: BuilderStep): string {
  const c = step.config ?? {};
  const text = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 70) : "");
  const rules = (group: unknown) => (isRecord(group) && Array.isArray(group.conditions) ? group.conditions.length : 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  switch (step.type) {
    case "wait": return `${c.amount ?? 1} ${c.unit ?? "days"}`;
    case "send_email": return text(c.subject) || (c.emailTemplateId ? "Uses a saved template" : "(no subject yet)");
    case "send_sms": case "send_push": return text(c.message) || "(no message yet)";
    case "create_activity": return text(c.summary) || String(c.activityType ?? "call");
    case "stop": case "lead_mark_lost": return text(c.reason);
    case "condition": return plural(rules(c.condition), "rule");
    case "wait_for_condition": return `Until ${plural(rules(c.condition), "rule")} match`;
    case "wait_for_trigger": return `Until ${plural(Array.isArray(c.triggers) ? c.triggers.length : 1, "event")}`;
    case "variables": return Object.keys(isRecord(c.set) ? c.set : {}).join(", ");
    case "choose": {
      const n = slotsOf(step).filter((s) => s.slot !== "default").length;
      return `${n} branch${n === 1 ? "" : "es"}`;
    }
    case "repeat": return c.mode === "count" ? `${c.count ?? 2} times` : c.mode === "for_each" ? "For each item" : `${c.mode ?? ""} conditions match`;
    default: return "";
  }
}

/* ── the Nodes palette, Find, Undo ───────────────────────────────────────── */

/** The palette's groups. Every step type is in exactly one (tests/journeyCanvas.test.ts). */
export const JOURNEY_PALETTE = [
  { group: "messages", label: "Messages", types: ["send_email", "send_sms", "send_push", "send_review_request", "send_service_reminder", "send_signing_reminder", "send_survey_reminder"] },
  { group: "crm", label: "CRM", types: ["create_activity", "move_stage", "assign_user", "lead_mark_won", "lead_mark_lost", "lead_reopen", "add_tag", "remove_tag"] },
  { group: "timing", label: "Timing", types: ["wait", "wait_for_trigger", "wait_for_condition"] },
  { group: "logic", label: "Logic", types: ["condition", "choose", "repeat", "variables", "stop"] },
] as const satisfies readonly { group: string; label: string; types: readonly JourneyStepType[] }[];

export type PaletteGroup = (typeof JOURNEY_PALETTE)[number]["group"];

/** Which palette group a type belongs to; undefined for a type this build doesn't know. */
export function paletteGroup(type: string): PaletteGroup | undefined {
  return JOURNEY_PALETTE.find((g) => (g.types as readonly string[]).includes(type))?.group;
}

/**
 * A new step of `type`, seeded exactly as the list view seeds one (initialConfig), placed at `at` — or at the end of
 * the journey. A Choose or Repeat is refused where the list view wouldn't offer one: too deep to nest.
 */
export function addNewStep(steps: BuilderStep[], type: string, id: string, at: { list: ListRef; index: number } | null): BuilderStep[] | string {
  const place = at ?? { list: null, index: steps.length };
  const depth = place.list ? (locate(steps, place.list.parentId)?.depth ?? 0) + 1 : 0;
  if ((type === "choose" || type === "repeat") && depth + 1 >= JOURNEY_LIMITS.depth) {
    return `Steps can only nest ${JOURNEY_LIMITS.depth - 1} levels deep`;
  }
  return insertStep(steps, place.list, place.index, { id, type, config: initialConfig(type) });
}

/** Every step at every depth, in running order. */
function everyStep(steps: BuilderStep[]): BuilderStep[] {
  return steps.filter(isRecord).flatMap((step) => [step, ...slotsOf(step).flatMap((s) => everyStep(s.steps))]);
}

/** The text an author typed into a step — not the steps nested inside it, which are found on their own. */
function words(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" || typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => words(v, out));
  else if (isRecord(value)) for (const [key, v] of Object.entries(value)) if (key !== "sequence" && key !== "default") words(v, out);
  return out;
}

/** Find on the canvas: steps whose name, type or own text mentions the query. */
export function findSteps(steps: BuilderStep[], query: string): { id: string; label: string; snippet: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const labels: Record<string, string> = JOURNEY_STEP_LABELS;
  return everyStep(steps).flatMap((step) => {
    const label = labels[step.type] ?? step.type;
    const text = words(step.config);
    const name = (step as { name?: unknown }).name;
    const hay = [label, step.type, step.id, typeof name === "string" ? name : "", ...text];
    if (!hay.some((h) => h.toLowerCase().includes(q))) return [];
    return [{ id: step.id, label, snippet: (text.find((t) => t.toLowerCase().includes(q)) ?? stepSummary(step)).slice(0, 80) }];
  });
}

/** Undo history over snapshots of the steps (FlowBuilder keeps 50). */
export type History<T> = { past: T[]; future: T[] };
export const HISTORY_LIMIT = 50;

export function recordHistory<T>(history: History<T>, current: T): History<T> {
  return { past: [...history.past, current].slice(-HISTORY_LIMIT), future: [] };
}

export function undoHistory<T>(history: History<T>, current: T): { history: History<T>; value: T } | null {
  if (!history.past.length) return null;
  return { history: { past: history.past.slice(0, -1), future: [...history.future, current] }, value: history.past.at(-1)! };
}

export function redoHistory<T>(history: History<T>, current: T): { history: History<T>; value: T } | null {
  if (!history.future.length) return null;
  return { history: { past: [...history.past, current], future: history.future.slice(0, -1) }, value: history.future.at(-1)! };
}
