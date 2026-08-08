"use client";

import { useMemo, useRef, useState } from "react";
import { createJourney } from "@/app/actions/journeys";
import { JOURNEY_LIMITS, JOURNEY_STEP_LABELS, JOURNEY_TRIGGERS } from "@/lib/journeyTypes";
import { JOURNEY_TRIGGER_LABELS, type JourneyTriggerSpec } from "@/lib/journeyTriggers";
import { BuilderSaveStatus, BuilderWorkspaceBar, BuilderWorkspaceShell } from "@/components/builder-workspace";
import { JOURNEY_RUN_MODES, RUN_MODE_LEGACY_NOTE } from "@/lib/journeyRunModes";

export type JourneyOption = { id: string; name: string };

type BuilderStep = {
  id: string;
  type: string;
  /** Keep going if this step fails. Round-tripped so saving cannot drop it. */
  continueOnError?: boolean;
  /** Whether this step runs. Round-tripped for the same reason: a step silently
   *  re-armed by a save is a message sent that nobody asked for. */
  enabled?: boolean;
  config: Record<string, unknown>;
};

/**
 * The step types with NO visual editor here — say so rather than pretend.
 *
 * They are authored as JSON today. What this builder guarantees is that opening
 * and re-saving a journey that contains one does not damage it: the step's
 * config is carried through verbatim, its type cannot be changed by a stray
 * click on the type dropdown, and the panel shows what is inside it. Silently
 * dropping the branches — which is what would happen if these types were simply
 * unknown to the builder — would destroy work with no error and no undo.
 *
 * `wait_for_trigger` and `variables` join the containers for exactly the same
 * reason. A wait's `triggers` array and a variables step's `set` map are
 * structured config this form has no widget for, and losing either on save is
 * silent: a wait with no triggers fails validation on the next publish, and a
 * variables step with an empty `set` would leave every later `{{var_…}}`
 * rendering blank with nothing on screen to explain it.
 */
const READ_ONLY_STEP_TYPES = new Set([
  "choose",
  "repeat",
  "wait_for_trigger",
  "variables",
  // A wait_for_condition holds a whole condition GROUP, which is more than the
  // single-clause editor below can express — the same reason a rich `condition`
  // step is carried rather than edited here.
  "wait_for_condition",
]);

/**
 * A `condition` whose group this form CANNOT represent.
 *
 * The editor below is a single clause: one field, one operator, one value,
 * under `and`. Everything it saves is rebuilt from those three inputs — which
 * means anything richer that was authored as JSON was, until now, silently
 * flattened to `conditions[0]` on the next save. Every other clause, every
 * nested group, and (the reason this became urgent) every `not`, gone; no
 * error, no undo, and a journey that now enrols the exact set of people it was
 * written to exclude.
 *
 * `not` did not create that hole, it made it reachable: `not` is precisely the
 * kind of thing someone hand-authors into a condition step. So a group the form
 * cannot round-trip makes the step read-only, exactly as a container is.
 *
 * A step with NO stored group is a new one the form is about to build — that is
 * the flat field/operator/value shape, and it is editable.
 */
function complexCondition(config: Record<string, unknown>): boolean {
  const group = config.condition;
  if (!isRecord(group)) return false;
  if (group.logic != null && group.logic !== "and") return true;
  const list = group.conditions;
  if (!Array.isArray(list) || list.length !== 1) return true;
  return !isRecord(list[0]) || Array.isArray((list[0] as Record<string, unknown>).conditions);
}

/** Every reason a step is carried through verbatim rather than edited here. */
function isReadOnlyStep(step: BuilderStep): boolean {
  if (READ_ONLY_STEP_TYPES.has(step.type)) return true;
  return step.type === "condition" && complexCondition(step.config);
}

/** How many leaf clauses a group holds, at every depth. */
function countClauses(group: unknown): number {
  if (!isRecord(group) || !Array.isArray(group.conditions)) return 0;
  return group.conditions.reduce<number>(
    (total, entry) =>
      total + (isRecord(entry) && Array.isArray(entry.conditions) ? countClauses(entry) : 1),
    0,
  );
}

/** The one-line summary shown for a step the form cannot edit. */
function readOnlySummary(step: BuilderStep): string {
  if (step.type === "condition") {
    const group = isRecord(step.config.condition) ? step.config.condition : {};
    const clauses = countClauses(group);
    return `Condition (${String(group.logic ?? "and")}): ${clauses} clause${clauses === 1 ? "" : "s"}`;
  }
  if (step.type === "choose") {
    const options = Array.isArray(step.config.options) ? step.config.options.length : 0;
    return `${options} branch${options === 1 ? "" : "es"}${step.config.default ? " + default" : ""}`;
  }
  if (step.type === "repeat") return `Repeat: ${String(step.config.mode ?? "?")}`;
  if (step.type === "wait_for_trigger") {
    const triggers = Array.isArray(step.config.triggers) ? step.config.triggers : [];
    return `Wait for ${triggers.join(" or ") || "?"} (timeout ${String(step.config.timeoutMinutes ?? "?")} min)`;
  }
  if (step.type === "wait_for_condition") {
    const clauses = countClauses(step.config.condition);
    return `Wait until ${clauses} condition${clauses === 1 ? "" : "s"} hold (timeout ${String(step.config.timeoutMinutes ?? "?")} min)`;
  }
  const names = isRecord(step.config.set) ? Object.keys(step.config.set) : [];
  return `Sets ${names.join(", ") || "nothing"}`;
}

export type JourneyBuilderDefaults = {
  name?: string;
  description?: string | null;
  category?: string;
  /**
   * The journey's CURRENT mode, straight from the row — not a suggestion.
   * Undefined only for a journey being created; anything else and the control
   * would show "single" over a row that says "parallel".
   */
  runMode?: string;
  /**
   * Every trigger the version listens for, in the author's order. Read through
   * the tolerant reader on the server, so a converted-rule draft carrying a
   * trigger name this engine never had opens for editing instead of throwing.
   */
  triggers?: JourneyTriggerSpec[];
  conditionSource?: string;
  conditionProvince?: string;
  minValueRands?: number | null;
  definition?: { startStepId?: string | null; steps?: BuilderStep[] } | null;
};

// One source, shared with the trace — a second copy is how the builder and the
// activity trace end up calling the same step type two different things. The
// map moved to journeyTypes.ts and is typed Record<JourneyStepType, string>, so
// a new step type is a compile error until it is given a name here.
const stepLabels: Record<string, string> = JOURNEY_STEP_LABELS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanSteps(defaults?: JourneyBuilderDefaults["definition"]): BuilderStep[] {
  const existing = (defaults?.steps ?? []).filter(
    (step) => step.config?.systemGenerated !== true
  );
  if (existing.length === 0) {
    return [{ id: "step_1", type: "create_activity", config: { activityType: "call", dueDays: 0 } }];
  }
  return existing.map((step) => {
    const config = { ...step.config };
    const carried = { id: step.id, type: step.type, continueOnError: step.continueOnError, enabled: step.enabled, config };
    // A container's config holds its nested sequences, and a rich condition's
    // holds a group this form cannot rebuild. Nothing below may touch either —
    // carry them through byte-for-byte.
    if (isReadOnlyStep(carried)) return carried;
    if (step.type === "condition" && isRecord(config.condition)) {
      const group = config.condition;
      const first = Array.isArray(group.conditions) && isRecord(group.conditions[0])
        ? group.conditions[0]
        : null;
      if (first) {
        config.field = first.field;
        config.operator = first.operator;
        config.value = first.value;
      }
    }
    return { id: step.id, type: step.type, continueOnError: step.continueOnError, enabled: step.enabled, config };
  });
}

export default function JourneyBuilder({
  stages,
  users,
  templates,
  tags,
  segments,
  defaults = {},
  submitAction,
  submitLabel = "Save journey draft",
}: {
  stages: JourneyOption[];
  users: JourneyOption[];
  templates: JourneyOption[];
  tags: JourneyOption[];
  segments: JourneyOption[];
  defaults?: JourneyBuilderDefaults;
  submitAction?: (formData: FormData) => Promise<void>;
  submitLabel?: string;
}) {
  const counter = useRef(100);
  const [triggers, setTriggers] = useState<JourneyTriggerSpec[]>(
    defaults.triggers?.length ? defaults.triggers : [{ type: "lead_created", config: {} }],
  );
  const [category, setCategory] = useState(defaults.category ?? "automation");
  // Not parseRunMode() — that lives beside basePrisma and cannot cross into the
  // browser. An unrecognised stored value shows as "nothing selected", which is
  // honest: the server would read it as `single`, and pretending the radio was
  // already on `single` would hide a row that does not say that.
  const [runMode, setRunMode] = useState(defaults.runMode ?? "single");
  const [conditionSource, setConditionSource] = useState(defaults.conditionSource ?? "");
  const [conditionProvince, setConditionProvince] = useState(defaults.conditionProvince ?? "");
  const [minValueRands, setMinValueRands] = useState(
    defaults.minValueRands == null ? "" : String(defaults.minValueRands)
  );
  const [steps, setSteps] = useState<BuilderStep[]>(cleanSteps(defaults.definition));

  /**
   * Edit ONE trigger in place. Everything else in the list is left untouched —
   * including a type this builder has no dropdown entry for, which is how a
   * converted-rule draft survives being opened and re-saved.
   */
  const patchTrigger = (index: number, patch: Partial<JourneyTriggerSpec>) => {
    setTriggers((current) => current.map((spec, i) => (i === index ? { ...spec, ...patch } : spec)));
  };
  // Changing the TYPE clears that trigger's config: `stageId` means nothing to
  // lead_idle, and carrying it over would save a filter the engine never reads.
  const setTriggerType = (index: number, type: string) => patchTrigger(index, { type, config: {} });
  const setTriggerConfig = (index: number, config: Record<string, unknown>) =>
    patchTrigger(index, { config });
  // A blank id is stored as ABSENT, not as "". Empty-string ids would all look
  // identical to parseJourneyTriggers' uniqueness check and be refused as
  // duplicates the moment a second trigger was added.
  const setTriggerId = (index: number, id: string) =>
    patchTrigger(index, { id: id.trim() ? id.trim() : undefined });

  const setConfig = (index: number, key: string, value: unknown) => {
    setSteps((current) => current.map((step, i) =>
      i === index ? { ...step, config: { ...step.config, [key]: value } } : step
    ));
  };

  const setType = (index: number, type: string) => {
    const initial: Record<string, unknown> =
      type === "wait" ? { amount: 1, unit: "days" }
      : type === "create_activity" ? { activityType: "call", dueDays: 0 }
      : type === "condition" ? { field: "lead.source", operator: "equals", value: "" }
      // A mark-lost step will not SAVE without a reason (parseLeadOutcomeConfig
      // refuses one), so the field is seeded empty and visible rather than left
      // for the author to discover on a rejected save.
      : type === "lead_mark_lost" ? { reason: "" }
      : {};
    setSteps((current) => current.map((step, i) =>
      i === index ? { ...step, type, config: initial } : step
    ));
  };

  const addStep = () => {
    counter.current += 1;
    setSteps((current) => [
      ...current,
      { id: `step_${counter.current}`, type: "wait", config: { amount: 1, unit: "days" } },
    ]);
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    setSteps((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const entryConditions = useMemo(() => {
    const conditions: Array<Record<string, unknown>> = [];
    if (conditionSource.trim()) {
      conditions.push({
        field: "lead.source",
        operator: conditionSource.includes(",") ? "in" : "equals",
        value: conditionSource.trim(),
      });
    }
    if (conditionProvince.trim()) {
      conditions.push({ field: "contact.province", operator: "equals", value: conditionProvince.trim() });
    }
    if (minValueRands !== "") {
      conditions.push({
        field: "lead.valueCents",
        operator: "greater_or_equal",
        value: Math.round(Number(minValueRands) * 100),
      });
    }
    return { logic: "and", conditions };
  }, [conditionSource, conditionProvince, minValueRands]);

  const definition = useMemo(() => {
    const mapped = steps.map((step, index) => {
      const nextStepId = steps[index + 1]?.id ?? null;
      // Spreading `step` is what preserves a container's nested sequences and
      // every step's continueOnError. Only a condition the form can actually
      // represent has its config rebuilt; a richer group is carried, along with
      // its own trueStepId/falseStepId, rather than rewritten from one clause.
      if (step.type !== "condition" || isReadOnlyStep(step)) return { ...step, nextStepId };
      const stopId = `${step.id}_false_stop`;
      return {
        ...step,
        nextStepId,
        config: {
          condition: {
            logic: "and",
            conditions: [{
              field: step.config.field,
              operator: step.config.operator,
              value: step.config.value,
            }],
          },
          trueStepId: nextStepId,
          falseStepId: stopId,
        },
      };
    });
    // Only for the conditions this form generated a false-branch for. A carried
    // condition already names its own falseStepId, and minting a second stop
    // step for it would be an orphan the parser then rejects.
    const generatedStops = steps
      .filter((step) => step.type === "condition" && !isReadOnlyStep(step))
      .map((step) => ({
        id: `${step.id}_false_stop`,
        type: "stop",
        nextStepId: null,
        config: { reason: "Condition did not match", systemGenerated: true },
      }));
    return {
      startStepId: steps[0]?.id ?? null,
      steps: [...mapped, ...generatedStops],
    };
  }, [steps]);

  return (
    <form action={submitAction ?? createJourney} className="space-y-5">
      <input type="hidden" name="triggers" value={JSON.stringify(triggers)} />
      <input type="hidden" name="entryConditions" value={JSON.stringify(entryConditions)} />
      <input type="hidden" name="definition" value={JSON.stringify(definition)} />

      <BuilderWorkspaceShell className="min-h-0">
        <BuilderWorkspaceBar
          title={defaults.name || "New journey"}
          description="Configure enrollment, entry rules and the ordered customer journey."
          status={<BuilderSaveStatus status="Unsaved changes" />}
        >
          <button className="btn-primary btn-sm">{submitLabel}</button>
        </BuilderWorkspaceBar>
        <div className="space-y-5 bg-[#0f1412] p-3 sm:p-5">

      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="label">Journey name</label>
          <input name="name" className="input" required defaultValue={defaults.name ?? ""} />
        </div>
        <div>
          <label className="label">Type</label>
          <select name="category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="automation">CRM automation</option>
            <option value="marketing">Marketing journey</option>
          </select>
        </div>
      </div>
      <div>
        <label className="label">Description</label>
        <textarea name="description" className="input min-h-20" defaultValue={defaults.description ?? ""} />
      </div>

      <div className="rounded-lg border border-slate-800 p-4 space-y-3">
        <h3 className="font-semibold">1. Enrollment triggers</h3>
        <p className="text-xs text-muted-foreground">
          Anyone who matches <strong>any one</strong> of these is enrolled — once, even if
          several of them fit. Give a trigger an ID to branch on it later with the
          <code className="mx-1">event.triggerId</code> condition; two triggers of the same
          kind each need one.
        </p>

        {triggers.map((spec, index) => {
          const config = spec.config ?? {};
          return (
            <div key={index} className="rounded-lg border border-slate-800/70 p-3 space-y-2">
              <div className="grid md:grid-cols-[2fr_1fr_auto] gap-2 items-start">
                {/* Rendered FROM the declared list, not spelled out by hand. The
                    hand-written copy is how an option could appear here that
                    nothing in the engine could ever act on. */}
                <select
                  className="input"
                  aria-label="Enrollment trigger"
                  value={spec.type}
                  onChange={(e) => setTriggerType(index, e.target.value)}
                >
                  {/* A stored type this build does not offer — a draft converted
                      from the retired rules engine — is shown as itself rather
                      than silently snapping to the first option on render. */}
                  {!(JOURNEY_TRIGGERS as readonly string[]).includes(spec.type) && (
                    <option value={spec.type}>{spec.type} (not available)</option>
                  )}
                  {JOURNEY_TRIGGERS.map((type) => (
                    <option key={type} value={type}>{JOURNEY_TRIGGER_LABELS[type]}</option>
                  ))}
                </select>
                <input
                  className="input"
                  aria-label="Trigger ID"
                  placeholder="ID (optional)"
                  value={spec.id ?? ""}
                  onChange={(e) => setTriggerId(index, e.target.value)}
                />
                <button
                  type="button"
                  className="text-xs text-red-400 px-2 py-2 disabled:opacity-40"
                  disabled={triggers.length === 1}
                  title={triggers.length === 1 ? "A journey needs at least one trigger" : "Remove this trigger"}
                  onClick={() => setTriggers((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>

              {spec.type === "stage_entered" && (
                <select className="input" aria-label="Stage" value={String(config.stageId ?? "")} onChange={(e) => setTriggerConfig(index, { stageId: e.target.value })}>
                  <option value="">Any stage</option>
                  {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                </select>
              )}
              {spec.type === "lead_idle" && (
                <input className="input" type="number" min={1} value={String(config.idleDays ?? 3)} onChange={(e) => setTriggerConfig(index, { idleDays: Number(e.target.value) })} aria-label="Idle days" />
              )}
              {spec.type === "contact_segment" && (
                <div className="grid md:grid-cols-2 gap-2">
                  <select className="input" aria-label="Segment" value={String(config.segmentId ?? "")} onChange={(e) => setTriggerConfig(index, { ...config, segmentId: e.target.value })}>
                    <option value="">Choose segment</option>
                    {segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
                  </select>
                  <select className="input" aria-label="Re-enrollment window" value={String(config.repeat ?? "once")} onChange={(e) => setTriggerConfig(index, { ...config, repeat: e.target.value })}>
                    <option value="once">Enroll each contact once</option>
                    <option value="weekly">Allow weekly re-enrollment</option>
                    <option value="daily">Allow daily re-enrollment</option>
                  </select>
                </div>
              )}
              {spec.type === "win_back" && (
                <input className="input" type="number" min={3} value={String(config.inactiveMonths ?? 12)} onChange={(e) => setTriggerConfig(index, { inactiveMonths: Number(e.target.value) })} aria-label="Inactive months" />
              )}
            </div>
          );
        })}

        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={triggers.length >= JOURNEY_LIMITS.triggers}
          onClick={() => setTriggers((current) => [...current, { type: "lead_created", config: {} }])}
        >
          + Add another trigger
        </button>
      </div>

      {/* Re-enrolment. Sits directly under the trigger because it is the same
          question — what the trigger firing a SECOND time means — and because
          leaving it out of the form is what pinned every journey to whatever
          the database happened to hold. */}
      <fieldset className="rounded-lg border border-slate-800 p-4 space-y-3">
        <legend className="font-semibold px-1">2. If the same person is enrolled again</legend>
        <div className="space-y-2">
          {JOURNEY_RUN_MODES.map((mode) => (
            <label
              key={mode.value}
              className={`flex gap-3 rounded-lg border p-3 cursor-pointer ${
                runMode === mode.value ? "border-primary bg-primary/5" : "border-slate-800"
              }`}
            >
              <input
                type="radio"
                name="runMode"
                value={mode.value}
                className="mt-1"
                checked={runMode === mode.value}
                onChange={(e) => setRunMode(e.target.value)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{mode.label}</span>
                {/* One line of plain English each. Four bare keywords are not a
                    choice anybody can make. */}
                <span className="block text-xs text-slate-400 mt-0.5">{mode.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-slate-500">{RUN_MODE_LEGACY_NOTE}</p>
      </fieldset>

      <details className="rounded-lg border border-slate-800 p-4">
        <summary className="font-semibold cursor-pointer">3. Optional entry filters</summary>
        <div className="grid md:grid-cols-3 gap-3 mt-3">
          <div>
            <label className="label">Lead source</label>
            <input className="input" value={conditionSource} onChange={(e) => setConditionSource(e.target.value)} placeholder="facebook,website" />
          </div>
          <div>
            <label className="label">Province</label>
            <input className="input" value={conditionProvince} onChange={(e) => setConditionProvince(e.target.value)} />
          </div>
          <div>
            <label className="label">Minimum lead value (R)</label>
            <input className="input" type="number" value={minValueRands} onChange={(e) => setMinValueRands(e.target.value)} />
          </div>
        </div>
      </details>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">4. Journey steps</h3>
          <button type="button" className="btn-secondary btn-sm" onClick={addStep}>+ Add step</button>
        </div>
        {steps.map((step, index) => (
          <div
            key={step.id}
            className={`rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3 ${
              step.enabled === false ? "opacity-60" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="badge bg-slate-800 text-slate-300">{index + 1}</span>
              {/* A muted step still occupies its place in the sequence, so the
                  list has to show which one is off. Dimming alone is a hint, not
                  a statement — the badge is the statement. */}
              {step.enabled === false && (
                <span className="badge bg-amber-500/15 text-amber-300">Off</span>
              )}
              {/* Disabled for containers: changing the type resets config, and a
                  container's config IS its nested sequences. One stray click
                  would delete every branch with no error and no undo. */}
              <select
                className="input flex-1"
                value={step.type}
                disabled={isReadOnlyStep(step)}
                onChange={(e) => setType(index, e.target.value)}
              >
                {Object.entries(stepLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" className="btn-secondary btn-sm" onClick={() => moveStep(index, -1)}>↑</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => moveStep(index, 1)}>↓</button>
              <button type="button" className="text-red-400 text-sm" onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}>Remove</button>
            </div>

            {isReadOnlyStep(step) && (
              <div className="rounded border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-200/90">
                <p className="font-semibold text-amber-300">{readOnlySummary(step)}</p>
                <p className="mt-1 leading-5">
                  There is no visual editor for this step yet — it is authored as JSON. It is
                  carried through this form exactly as saved, so editing the rest of the journey
                  cannot damage it.
                </p>
              </div>
            )}

            {step.type === "send_email" && (
              <div className="space-y-2">
                <select className="input" value={String(step.config.emailTemplateId ?? "")} onChange={(e) => setConfig(index, "emailTemplateId", e.target.value)}>
                  <option value="">Write the subject and body below</option>
                  {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
                <input className="input" placeholder="Email subject" value={String(step.config.subject ?? "")} onChange={(e) => setConfig(index, "subject", e.target.value)} />
                <textarea className="input min-h-28" placeholder="Email body. Use {{first_name}}, {{name}}, {{model}}, {{value}}." value={String(step.config.body ?? "")} onChange={(e) => setConfig(index, "body", e.target.value)} />
              </div>
            )}
            {step.type === "send_sms" && <textarea className="input" placeholder="SMS message" value={String(step.config.message ?? "")} onChange={(e) => setConfig(index, "message", e.target.value)} />}
            {step.type === "send_push" && <input className="input" placeholder="Notification message" value={String(step.config.message ?? "")} onChange={(e) => setConfig(index, "message", e.target.value)} />}
            {step.type === "wait" && (
              <div className="grid grid-cols-2 gap-2">
                <input className="input" type="number" min={1} value={String(step.config.amount ?? 1)} onChange={(e) => setConfig(index, "amount", Number(e.target.value))} />
                <select className="input" value={String(step.config.unit ?? "days")} onChange={(e) => setConfig(index, "unit", e.target.value)}>
                  <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
                </select>
              </div>
            )}
            {step.type === "create_activity" && (
              <div className="grid md:grid-cols-4 gap-2">
                <select className="input" value={String(step.config.activityType ?? "call")} onChange={(e) => setConfig(index, "activityType", e.target.value)}>
                  <option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="whatsapp">WhatsApp</option><option value="todo">To-do</option>
                </select>
                <input className="input md:col-span-2" placeholder="Activity summary" value={String(step.config.summary ?? "")} onChange={(e) => setConfig(index, "summary", e.target.value)} />
                <input className="input" type="number" min={0} placeholder="Due days" value={String(step.config.dueDays ?? 0)} onChange={(e) => setConfig(index, "dueDays", Number(e.target.value))} />
                <select className="input md:col-span-4" value={String(step.config.assignToId ?? "")} onChange={(e) => setConfig(index, "assignToId", e.target.value)}>
                  <option value="">Lead/contact owner</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                </select>
              </div>
            )}
            {step.type === "move_stage" && <select className="input" value={String(step.config.stageId ?? "")} onChange={(e) => setConfig(index, "stageId", e.target.value)}><option value="">Choose stage</option>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>}
            {step.type === "assign_user" && <select className="input" value={String(step.config.userId ?? "")} onChange={(e) => setConfig(index, "userId", e.target.value)}><option value="">Choose user</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select>}
            {(step.type === "add_tag" || step.type === "remove_tag") && <select className="input" value={String(step.config.tagId ?? "")} onChange={(e) => setConfig(index, "tagId", e.target.value)}><option value="">Choose tag</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>}

            {/* The lead outcome steps. Each says which statuses it acts on,
                because "why did my step skip?" is otherwise a question only the
                run trace can answer — and the answer is always the same one. */}
            {step.type === "lead_mark_lost" && (
              <div className="space-y-2">
                <input
                  className="input"
                  placeholder="Lost reason (required) — e.g. Went with a competitor"
                  maxLength={JOURNEY_LIMITS.leadOutcomeReason}
                  value={String(step.config.reason ?? "")}
                  onChange={(e) => setConfig(index, "reason", e.target.value)}
                />
                <p className="text-xs text-slate-500">
                  Only an <strong>open</strong> lead is marked lost — one already won or lost is left
                  exactly as it is and the step records itself as skipped. Reports group closed-lost
                  leads by this reason, so it is required. Supports {"{{first_name}}"}, {"{{model}}"} and
                  the other message placeholders.
                </p>
              </div>
            )}
            {step.type === "lead_mark_won" && (
              <p className="text-xs text-slate-500">
                Only an <strong>open</strong> lead is marked won. A lead already won is left alone and
                the step records itself as skipped, so a journey that runs again cannot count the same
                sale twice or pay a referral fee twice. To win a lead that was closed, put a
                “Reopen lead” step in front of this one.
              </p>
            )}
            {step.type === "lead_reopen" && (
              <p className="text-xs text-slate-500">
                Puts a <strong>won or lost</strong> lead back to open and clears its lost reason. A lead
                that is already open is left alone and the step records itself as skipped.
              </p>
            )}
            {step.type === "condition" && !isReadOnlyStep(step) && (
              <div className="grid md:grid-cols-3 gap-2">
                <select className="input" value={String(step.config.field ?? "lead.source")} onChange={(e) => setConfig(index, "field", e.target.value)}>
                  <option value="lead.source">Lead source</option><option value="lead.status">Lead status</option><option value="lead.valueCents">Lead value (cents)</option><option value="lead.stageId">Lead stage</option><option value="contact.province">Contact province</option><option value="contact.tags">Contact tag ID</option><option value="contact.hasVehicle">Has vehicle</option>
                </select>
                <select className="input" value={String(step.config.operator ?? "equals")} onChange={(e) => setConfig(index, "operator", e.target.value)}>
                  <option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="contains">Contains</option><option value="greater_or_equal">At least</option><option value="less_or_equal">At most</option><option value="is_empty">Is empty</option><option value="is_not_empty">Is not empty</option>
                </select>
                <input className="input" placeholder="Value" value={String(step.config.value ?? "")} onChange={(e) => setConfig(index, "value", e.target.value)} />
                <p className="text-xs text-slate-500 md:col-span-3">Matching contacts continue. Non-matches stop safely.</p>
              </div>
            )}
            {step.type === "stop" && <input className="input" placeholder="Reason" value={String(step.config.reason ?? "")} onChange={(e) => setConfig(index, "reason", e.target.value)} />}

            {/* Offered for EVERY step type including
                the ones with no visual editor — muting a branch you cannot edit
                here is exactly when you need this, and the alternative is
                deleting it and losing its config, its id and its trace history.
                A disabled step is skipped and RECORDED as skipped, so the
                activity trace still explains the gap. */}
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={step.enabled !== false}
                onChange={(e) => setSteps((current) => current.map((s, i) =>
                  i === index ? { ...s, enabled: e.target.checked } : s
                ))}
              />
              Step is on
            </label>

            {/* Per step, because only the author knows which of their steps is
                load-bearing. One failed SMS used to fail the whole run and burn
                one of its three attempts, so a provider outage on a courtesy
                notification could permanently kill a journey whose remaining
                steps were the ones that mattered. */}
            {!isReadOnlyStep(step) && step.type !== "wait" && step.type !== "stop" && (
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={step.continueOnError === true}
                  onChange={(e) => setSteps((current) => current.map((s, i) =>
                    i === index ? { ...s, continueOnError: e.target.checked } : s
                  ))}
                />
                Keep going if this step fails
              </label>
            )}
          </div>
        ))}
      </div>

        </div>
      </BuilderWorkspaceShell>
    </form>
  );
}
