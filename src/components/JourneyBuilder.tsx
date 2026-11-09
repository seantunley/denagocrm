"use client";

import { useMemo, useState } from "react";
import { currencySymbol } from "@/lib/format";
import { useMoneyFormat } from "@/components/MoneyFormatProvider";
import { messageEditorHref } from "@/lib/customerMessagePlaces";
import { createJourney } from "@/app/actions/journeys";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import type { ActionResult } from "@/lib/actionResultTypes";
import { JOURNEY_EVENT_TRIGGERS, JOURNEY_LIMITS, JOURNEY_STEP_LABELS, JOURNEY_TRIGGERS, REPEAT_MODES } from "@/lib/journeyTypes";
import { JOURNEY_TRIGGER_LABELS, type JourneyTriggerSpec } from "@/lib/journeyTriggers";
import { BuilderSaveStatus, BuilderWorkspaceBar, BuilderWorkspaceShell } from "@/components/builder-workspace";
import { JOURNEY_RUN_MODES, RUN_MODE_LEGACY_NOTE } from "@/lib/journeyRunModes";
import { builderDefinition, builderSteps, conditionHasOwnTargets, emptyGroup, generatedStopId, initialConfig, isRecord, newWaitStep, type BuilderStep } from "@/lib/journeyBuilderDefinition";
import JourneyConditionGroupEditor from "@/components/JourneyConditionGroupEditor";
import JourneyCanvas from "@/components/JourneyCanvas";
import { JourneyModulesContext, useModuleBlock } from "@/components/journeyModulesContext";
import { missingModule, moduleLabel, TRIGGER_MODULE } from "@/lib/journeyModules";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";

export type JourneyOption = { id: string; name: string };

/** Containers (Choose, Repeat) hold their own step lists, nested up to the parser's depth limit. */
const CONTAINERS = new Set(["choose", "repeat"]);
/** Steps where "keep going if this step fails" means nothing: they wait, stop, or only steer. */
const NO_CONTINUE_ON_ERROR = new Set(["wait", "stop", "choose", "repeat", "wait_for_trigger", "wait_for_condition", "variables"]);

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

type Lists = { stages: JourneyOption[]; users: JourneyOption[]; templates: JourneyOption[]; tags: JourneyOption[] };

export default function JourneyBuilder({
  stages,
  users,
  templates,
  tags,
  segments,
  defaults = {},
  submitAction,
  submitLabel = "Save journey draft",
  enabledModules,
}: {
  /** The workspace's enabled modules: triggers and steps of any other module aren't offered. Omitted → all. */
  enabledModules?: string[];
  stages: JourneyOption[];
  users: JourneyOption[];
  templates: JourneyOption[];
  tags: JourneyOption[];
  segments: JourneyOption[];
  defaults?: JourneyBuilderDefaults;
  submitAction?: (formData: FormData) => Promise<ActionResult | void>;
  submitLabel?: string;
}) {
  const moneyFmt = useMoneyFormat();
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
  const [steps, setSteps] = useState<BuilderStep[]>(() => builderSteps(defaults.definition));
  // Both views edit the SAME steps, and saving goes through builderDefinition either way.
  const [view, setView] = useState<"canvas" | "list">("canvas");

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

  const definition = useMemo(() => builderDefinition(steps), [steps]);
  const lists: Lists = { stages, users, templates, tags };

  // The workspace's modules (journeyModules.ts): a trigger or step of a module it hasn't got isn't offered. One the
  // journey already uses stays visible with why, rather than silently becoming something else.
  const enabled = useMemo(() => (enabledModules ? new Set(enabledModules) : null), [enabledModules]);
  const triggerBlocked = (type: string) => {
    const off = enabled ? missingModule(TRIGGER_MODULE[type], enabled) : null;
    return off ? `needs ${moduleLabel(off)}` : null;
  };

  return (
    // SaveForm shows the strict validation message ("two triggers share an ID")
    // instead of an error page. Not reset on success: the steps live in state.
    <JourneyModulesContext.Provider value={enabled}>
    <SaveForm action={submitAction ?? createJourney} resetOnSuccess={false} className="space-y-5">
      <input type="hidden" name="triggers" value={JSON.stringify(triggers)} />
      <input type="hidden" name="entryConditions" value={JSON.stringify(entryConditions)} />
      <input type="hidden" name="definition" value={JSON.stringify(definition)} />

      <BuilderWorkspaceShell className="min-h-0">
        <BuilderWorkspaceBar
          title={defaults.name || "New journey"}
          description="Configure enrollment, entry rules and the ordered customer journey."
          status={<BuilderSaveStatus status="Unsaved changes" />}
        >
          <SaveButton className="btn-primary btn-sm">{submitLabel}</SaveButton>
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
                  {JOURNEY_TRIGGERS.filter((type) => !triggerBlocked(type) || type === spec.type).map((type) => (
                    <option key={type} value={type}>
                      {JOURNEY_TRIGGER_LABELS[type]}{triggerBlocked(type) ? ` (${triggerBlocked(type)})` : ""}
                    </option>
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
              {spec.type === "signing_unsigned" && (
                <label className="block text-xs text-muted-foreground">
                  Days after the document reached the signer
                  <input className="input mt-1" type="number" min={1} value={String(config.days ?? 3)} onChange={(e) => setTriggerConfig(index, { days: Number(e.target.value) })} aria-label="Days unsigned" />
                </label>
              )}
              {spec.type === "survey_unanswered" && (
                <label className="block text-xs text-muted-foreground">
                  Hours after the survey was sent
                  <input className="input mt-1" type="number" min={1} value={String(config.hours ?? 48)} onChange={(e) => setTriggerConfig(index, { hours: Number(e.target.value) })} aria-label="Hours unanswered" />
                </label>
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
            <label className="label">Minimum lead value ({currencySymbol(moneyFmt)})</label>
            <input className="input" type="number" value={minValueRands} onChange={(e) => setMinValueRands(e.target.value)} />
          </div>
        </div>
      </details>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">4. Journey steps</h3>
          <div className="flex rounded-lg border border-slate-800 p-0.5 text-xs" role="group" aria-label="How to show the steps">
            {(["canvas", "list"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={`rounded-md px-3 py-1.5 ${view === option ? "bg-primary/15 text-orange-200" : "text-slate-400 hover:text-slate-200"}`}
              >
                {option === "canvas" ? "Canvas" : "List"}
              </button>
            ))}
          </div>
        </div>
        {view === "canvas" ? (
          <JourneyCanvas
            steps={steps}
            onChange={setSteps}
            saveButton={<SaveButton className="btn-primary btn-sm">{submitLabel}</SaveButton>}
            renderEditor={(step, depth, onStepChange) => (
              <div className="space-y-3">
                <StepTypeSelect step={step} depth={depth} onChange={onStepChange} />
                {/* Nested steps are cards on the canvas, so the inspector edits this step only. */}
                <StepFields step={step} onChange={onStepChange} depth={depth} lists={lists} hideNested />
                <StepToggles step={step} onChange={onStepChange} />
              </div>
            )}
          />
        ) : (
          <StepList steps={steps} onChange={setSteps} depth={0} lists={lists} />
        )}
      </div>

        </div>
      </BuilderWorkspaceShell>
    </SaveForm>
    </JourneyModulesContext.Provider>
  );
}

/**
 * An ordered list of steps — the journey itself at depth 0, or a Choose branch / Repeat loop inside it. A nested list
 * can't be emptied: the parser refuses an empty sequence (a cursor that points at nothing).
 */
function StepList({ steps, onChange, depth, lists }: { steps: BuilderStep[]; onChange: (steps: BuilderStep[]) => void; depth: number; lists: Lists }) {
  const put = (index: number, step: BuilderStep) => onChange(steps.map((s, i) => (i === index ? step : s)));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div className={depth ? "space-y-2 border-l-2 border-slate-700/70 pl-3" : "space-y-3"}>
      {steps.map((step, index) => (
        <div key={step.id} className={`rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3 ${step.enabled === false ? "opacity-60" : ""}`}>
          <div className="flex items-center gap-2">
            <span className="badge bg-slate-800 text-slate-300">{index + 1}</span>
            {/* A muted step still occupies its place in the sequence, so the list has to show which one is off. */}
            {step.enabled === false && <span className="badge bg-amber-500/15 text-amber-300">Off</span>}
            <StepTypeSelect step={step} depth={depth} onChange={(next) => put(index, next)} />
            <button type="button" className="btn-secondary btn-sm" onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => move(index, 1)}>↓</button>
            <button type="button" className="text-red-400 text-sm disabled:opacity-40" disabled={depth > 0 && steps.length === 1} title={depth > 0 && steps.length === 1 ? "A branch needs at least one step" : undefined} onClick={() => onChange(steps.filter((_, i) => i !== index))}>Remove</button>
          </div>

          <StepFields step={step} onChange={(next) => put(index, next)} depth={depth} lists={lists} />
          <StepToggles step={step} onChange={(next) => put(index, next)} />
        </div>
      ))}
      <button type="button" className="btn-secondary btn-sm" onClick={() => onChange([...steps, newWaitStep()])}>+ Add step{depth ? " here" : ""}</button>
    </div>
  );
}

/** A step's type. Shared by the list and the canvas inspector. */
function StepTypeSelect({ step, depth, onChange }: { step: BuilderStep; depth: number; onChange: (step: BuilderStep) => void }) {
  // A container's config IS its branches — a stray pick in the type list would delete them with no undo, so ask first.
  const [retype, setRetype] = useState<string | null>(null);
  const changeType = (type: string) => onChange({ ...step, type, config: initialConfig(type) });
  const blocked = useModuleBlock().step;
  return (
    <>
      <select
        className="input flex-1"
        aria-label="Step type"
        value={step.type}
        onChange={(e) => (CONTAINERS.has(step.type) ? setRetype(e.target.value) : changeType(e.target.value))}
      >
        {/* A type this build doesn't know is shown as itself, not as whichever option happens to be first. */}
        {!(step.type in stepLabels) && <option value={step.type}>{step.type} (not available)</option>}
        {Object.entries(stepLabels)
          // Containers nest; the parser stops at its depth limit (JOURNEY_LIMITS.depth, counted from 1).
          .filter(([value]) => !CONTAINERS.has(value) || value === step.type || depth + 1 < JOURNEY_LIMITS.depth)
          // A step of a module this workspace hasn't got isn't offered — but one already in the journey stays, with why.
          .filter(([value]) => !blocked(value) || value === step.type)
          .map(([value, label]) => <option key={value} value={value}>{label}{blocked(value) ? ` (${blocked(value)})` : ""}</option>)}
      </select>
      <ConfirmActionDialog
        destructive
        open={retype !== null}
        onOpenChange={(open) => { if (!open) setRetype(null); }}
        title="Change this step's type?"
        description="Its branches and every step inside them are removed."
        confirmLabel="Change type"
        onConfirm={() => { if (retype) changeType(retype); setRetype(null); }}
      />
    </>
  );
}

function StepToggles({ step, onChange }: { step: BuilderStep; onChange: (step: BuilderStep) => void }) {
  return (
    <>
      {/* Offered for EVERY step type — muting a branch is exactly when you need it, and the alternative is deleting
          it and losing its config, its id and its trace history. A disabled step is skipped and RECORDED as skipped. */}
      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input type="checkbox" checked={step.enabled !== false} onChange={(e) => onChange({ ...step, enabled: e.target.checked })} />
        Step is on
      </label>
      {/* Per step, because only the author knows which of their steps is load-bearing. One failed SMS used to fail
          the whole run and burn one of its three attempts. */}
      {!NO_CONTINUE_ON_ERROR.has(step.type) && (
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={step.continueOnError === true} onChange={(e) => onChange({ ...step, continueOnError: e.target.checked })} />
          Keep going if this step fails
        </label>
      )}
    </>
  );
}

/** Minutes, shown as days, hours or minutes — whichever divides evenly. Capped at JOURNEY_LIMITS.waitDays. */
function TimeoutField({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
  return (
    <div className="grid grid-cols-2 gap-2">
      <input className="input" type="number" min={1} aria-label="Give up after" value={String(minutes / unit)} onChange={(e) => onChange(Math.max(1, Math.round(Number(e.target.value) || 1)) * unit)} />
      <select className="input" aria-label="Unit" value={unit} onChange={(e) => onChange(Math.max(1, Math.round(minutes / unit)) * Number(e.target.value))}>
        <option value={1}>Minutes</option><option value={60}>Hours</option><option value={1440}>Days</option>
      </select>
    </div>
  );
}

/** `hideNested`: a Choose's branches and a Repeat's loop are left out — the canvas shows those steps as cards. */
function StepFields({ step, onChange, depth, lists, hideNested = false }: { step: BuilderStep; onChange: (step: BuilderStep) => void; depth: number; lists: Lists; hideNested?: boolean }) {
  const { config } = step;
  const set = (key: string, value: unknown) => onChange({ ...step, config: { ...config, [key]: value } });
  const timeout = Number(config.timeoutMinutes) || 1440;
  const carryOn = (
    <label className="flex items-center gap-2 text-xs text-slate-400">
      <input type="checkbox" checked={config.continueOnTimeout !== false} onChange={(e) => set("continueOnTimeout", e.target.checked)} />
      If it gives up, carry on with the next step (otherwise the journey ends)
    </label>
  );

  switch (step.type) {
    case "send_email":
      return (
        <div className="space-y-2">
          <select className="input" value={String(config.emailTemplateId ?? "")} onChange={(e) => set("emailTemplateId", e.target.value)}>
            <option value="">Write the subject and body below</option>
            {lists.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
          <input className="input" placeholder="Email subject" value={String(config.subject ?? "")} onChange={(e) => set("subject", e.target.value)} />
          <textarea className="input min-h-28" placeholder="Email body. Use {{first_name}}, {{name}}, {{model}}, {{value}} — and {{delivery_date}} on a delivery trigger." value={String(config.body ?? "")} onChange={(e) => set("body", e.target.value)} />
        </div>
      );
    case "send_sms":
      return <textarea className="input" placeholder="SMS message" value={String(config.message ?? "")} onChange={(e) => set("message", e.target.value)} />;
    case "send_push":
      return <input className="input" placeholder="Notification message" value={String(config.message ?? "")} onChange={(e) => set("message", e.target.value)} />;
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <input className="input" type="number" min={1} value={String(config.amount ?? 1)} onChange={(e) => set("amount", Number(e.target.value))} />
          <select className="input" value={String(config.unit ?? "days")} onChange={(e) => set("unit", e.target.value)}>
            <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
          </select>
        </div>
      );
    case "create_activity":
      return (
        <div className="grid md:grid-cols-4 gap-2">
          <select className="input" value={String(config.activityType ?? "call")} onChange={(e) => set("activityType", e.target.value)}>
            <option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="whatsapp">WhatsApp</option><option value="todo">To-do</option>
          </select>
          <input className="input md:col-span-2" placeholder="Activity summary" value={String(config.summary ?? "")} onChange={(e) => set("summary", e.target.value)} />
          <input className="input" type="number" min={0} placeholder="Due days" value={String(config.dueDays ?? 0)} onChange={(e) => set("dueDays", Number(e.target.value))} />
          <select className="input md:col-span-4" value={String(config.assignToId ?? "")} onChange={(e) => set("assignToId", e.target.value)}>
            <option value="">Lead/contact owner</option>
            {lists.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </div>
      );
    case "move_stage":
      return <select className="input" value={String(config.stageId ?? "")} onChange={(e) => set("stageId", e.target.value)}><option value="">Choose stage</option>{lists.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>;
    case "assign_user":
      return <select className="input" value={String(config.userId ?? "")} onChange={(e) => set("userId", e.target.value)}><option value="">Choose user</option>{lists.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select>;
    case "add_tag":
    case "remove_tag":
      return <select className="input" value={String(config.tagId ?? "")} onChange={(e) => set("tagId", e.target.value)}><option value="">Choose tag</option>{lists.tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>;

    // The lead outcome steps. Each says which statuses it acts on, because "why did my step skip?" is otherwise a
    // question only the run trace can answer — and the answer is always the same one.
    case "lead_mark_lost":
      return (
        <div className="space-y-2">
          <input className="input" placeholder="Lost reason (required) — e.g. Went with a competitor" maxLength={JOURNEY_LIMITS.leadOutcomeReason} value={String(config.reason ?? "")} onChange={(e) => set("reason", e.target.value)} />
          <p className="text-xs text-slate-500">
            Only an <strong>open</strong> lead is marked lost — one already won or lost is left
            exactly as it is and the step records itself as skipped. Reports group closed-lost
            leads by this reason, so it is required. Supports {"{{first_name}}"}, {"{{model}}"} and
            the other message placeholders.
          </p>
        </div>
      );
    case "lead_mark_won":
      return (
        <p className="text-xs text-slate-500">
          Only an <strong>open</strong> lead is marked won. A lead already won is left alone and
          the step records itself as skipped, so a journey that runs again cannot count the same
          sale twice or pay a referral fee twice. To win a lead that was closed, put a
          “Reopen lead” step in front of this one.
        </p>
      );
    // The module steps have nothing to configure here: what they send is the editable template, linked, and who they
    // reach comes from the trigger. Saying which trigger is the whole of the help.
    case "send_review_request":
      return (
        <p className="text-xs text-slate-500">
          Emails the customer a Google review request — the{" "}
          <a className="underline" href={messageEditorHref("review_service")}>service</a> or{" "}
          <a className="underline" href={messageEditorHref("review_delivery")}>delivery</a>{" "}
          template, depending on the trigger. At most once per customer every 90 days, never to someone who
          opted out, and only with a Google Place ID set up.
        </p>
      );
    case "send_service_reminder":
      return (
        <p className="text-xs text-slate-500">
          Emails the customer that their vehicle is due for a service, once per due date. Needs the “Vehicle is
          due for a service” trigger. Uses the template picked under Settings → Email → Service reminders, or
          the <a className="underline" href={messageEditorHref("service_reminder")}>Service reminder</a> template.
        </p>
      );
    case "send_signing_reminder":
      return (
        <p className="text-xs text-slate-500">
          Sends the signer one reminder with their own signing link, by email and WhatsApp (the{" "}
          <a className="underline" href={messageEditorHref("reminder")}>signing reminder</a> templates). Needs the
          “Document sent for signing isn&apos;t signed” trigger. Once per signer, and never once they have signed.
        </p>
      );
    case "send_survey_reminder":
      return (
        <p className="text-xs text-slate-500">
          Sends one reminder with the survey link (the{" "}
          <a className="underline" href={messageEditorHref("survey_reminder")}>survey reminder</a> templates). Needs
          the “Automatic survey isn&apos;t answered” trigger. Once per survey, never after it is answered.
        </p>
      );
    case "lead_reopen":
      return (
        <p className="text-xs text-slate-500">
          Puts a <strong>won or lost</strong> lead back to open and clears its lost reason. A lead
          that is already open is left alone and the step records itself as skipped.
        </p>
      );
    case "stop":
      return <input className="input" placeholder="Reason" value={String(config.reason ?? "")} onChange={(e) => set("reason", e.target.value)} />;

    case "condition": {
      // A condition authored with its own jump targets keeps them; the builder's own pattern is "carry on, or stop".
      const ownTargets = depth === 0 && conditionHasOwnTargets(step);
      const others = config.falseStepId === generatedStopId(step.id) ? "others stop here" : `others go to ${String(config.falseStepId || "the next step")}`;
      return (
        <div className="space-y-2">
          <JourneyConditionGroupEditor value={config.condition} onChange={(group) => set("condition", group)} />
          <p className="text-xs text-slate-500">
            {ownTargets
              ? `Matching customers go to ${String(config.trueStepId || "the next step")}; ${others} (set when this journey was written — kept as saved).`
              : "Matching customers carry on. Others stop here."}
          </p>
        </div>
      );
    }
    case "wait_for_condition":
      return (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">Wait until:</p>
          <JourneyConditionGroupEditor value={config.condition} onChange={(group) => set("condition", group)} />
          <p className="text-xs text-slate-400">Give up after (at most {JOURNEY_LIMITS.waitDays} days):</p>
          <TimeoutField minutes={timeout} onChange={(minutes) => set("timeoutMinutes", minutes)} />
          {carryOn}
        </div>
      );
    case "wait_for_trigger": {
      const chosen = Array.isArray(config.triggers) ? config.triggers.map(String) : typeof config.triggers === "string" ? [config.triggers] : [];
      return (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">Wait until any of these happens (up to {JOURNEY_LIMITS.waitTriggers}):</p>
          <div className="grid sm:grid-cols-2 gap-1">
            {JOURNEY_EVENT_TRIGGERS.map((trigger) => (
              <label key={trigger} className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={chosen.includes(trigger)}
                  disabled={!chosen.includes(trigger) && chosen.length >= JOURNEY_LIMITS.waitTriggers}
                  onChange={(e) => set("triggers", e.target.checked ? [...chosen, trigger] : chosen.filter((t) => t !== trigger))}
                />
                {JOURNEY_TRIGGER_LABELS[trigger]}
              </label>
            ))}
          </div>
          <p className="text-xs text-slate-400">Give up after (at most {JOURNEY_LIMITS.waitDays} days):</p>
          <TimeoutField minutes={timeout} onChange={(minutes) => set("timeoutMinutes", minutes)} />
          {carryOn}
        </div>
      );
    }
    case "variables": {
      const entries = Object.entries(isRecord(config.set) ? config.set : {}).map(([name, template]) => [name, String(template ?? "")] as const);
      const save = (next: (readonly [string, string])[]) => set("set", Object.fromEntries(next));
      return (
        <div className="space-y-2">
          {entries.map(([name, template], i) => (
            <div key={i} className="grid md:grid-cols-[1fr_2fr_auto] gap-2">
              <input className="input" aria-label="Variable name" placeholder="name (letters, numbers, _)" value={name} onChange={(e) => save(entries.map((entry, j) => (j === i ? [e.target.value.trim(), entry[1]] as const : entry)))} />
              <input className="input" aria-label="Value" placeholder="Value — may use {{first_name}} and the other placeholders" maxLength={JOURNEY_LIMITS.variableChars} value={template} onChange={(e) => save(entries.map((entry, j) => (j === i ? [entry[0], e.target.value] as const : entry)))} />
              <button type="button" className="text-xs text-red-400 px-2 disabled:opacity-40" disabled={entries.length === 1} onClick={() => save(entries.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          {entries.length < JOURNEY_LIMITS.variables && <button type="button" className="btn-secondary btn-sm" onClick={() => save([...entries, [`var${entries.length + 1}`, ""]])}>+ Variable</button>}
          <p className="text-xs text-slate-500">Use one later as {"{{var_name}}"} in a message, or as “A journey variable” in a condition.</p>
        </div>
      );
    }
    case "choose": {
      const options = Array.isArray(config.options) ? config.options.map((o) => (isRecord(o) ? o : {})) : [];
      const setOption = (i: number, option: Record<string, unknown>) => set("options", options.map((o, j) => (j === i ? option : o)));
      const fallback = Array.isArray(config.default) ? (config.default as BuilderStep[]) : null;
      return (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">The first branch whose conditions match runs; the rest are skipped.</p>
          {options.map((option, i) => (
            <div key={i} className="rounded-lg border border-slate-700/70 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-200">Branch {i + 1}</p>
                <button type="button" className="text-xs text-red-400 disabled:opacity-40" disabled={options.length === 1} onClick={() => set("options", options.filter((_, j) => j !== i))}>Remove branch</button>
              </div>
              {option.conditions == null ? (
                <p className="text-xs text-slate-400">Everyone who gets here. <button type="button" className="text-orange-300 underline" onClick={() => setOption(i, { ...option, conditions: emptyGroup() })}>Add conditions</button></p>
              ) : (
                <JourneyConditionGroupEditor value={option.conditions} onChange={(group) => setOption(i, { ...option, conditions: group })} />
              )}
              {!hideNested && <>
                <p className="text-xs text-slate-400">Then:</p>
                <StepList steps={Array.isArray(option.sequence) ? (option.sequence as BuilderStep[]) : []} onChange={(seq) => setOption(i, { ...option, sequence: seq })} depth={depth + 1} lists={lists} />
              </>}
            </div>
          ))}
          {options.length < JOURNEY_LIMITS.chooseOptions && (
            <button type="button" className="btn-secondary btn-sm" onClick={() => set("options", [...options, { conditions: emptyGroup(), sequence: [newWaitStep()] }])}>+ Branch</button>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={Boolean(fallback)} onChange={(e) => {
              const next = { ...config };
              if (e.target.checked) next.default = [newWaitStep()]; else delete next.default;
              onChange({ ...step, config: next });
            }} />
            If no branch matches, run other steps (otherwise carry on below)
          </label>
          {fallback && !hideNested && <StepList steps={fallback} onChange={(seq) => set("default", seq)} depth={depth + 1} lists={lists} />}
        </div>
      );
    }
    case "repeat": {
      const mode = String(config.mode ?? "count");
      return (
        <div className="space-y-2">
          <select className="input" aria-label="Repeat how" value={mode} onChange={(e) => {
            const next: Record<string, unknown> = { ...config, mode: e.target.value };
            if ((e.target.value === "while" || e.target.value === "until") && !isRecord(next[e.target.value])) next[e.target.value] = emptyGroup();
            if (e.target.value === "count" && !next.count) next.count = 2;
            onChange({ ...step, config: next });
          }}>
            {REPEAT_MODES.map((m) => <option key={m} value={m}>{m === "count" ? "A set number of times" : m === "while" ? "While conditions match" : m === "until" ? "Until conditions match" : "Once for each item in a list"}</option>)}
          </select>
          {mode === "count" && <input className="input" type="number" min={1} max={JOURNEY_LIMITS.repeatIterations} aria-label="Times" value={String(config.count ?? 2)} onChange={(e) => set("count", Number(e.target.value))} />}
          {(mode === "while" || mode === "until") && <JourneyConditionGroupEditor value={config[mode]} onChange={(group) => set(mode, group)} />}
          {mode === "for_each" && (Array.isArray(config.items) ? (
            <input className="input" aria-label="Items" placeholder="item one, item two" value={config.items.map(String).join(", ")} onChange={(e) => set("items", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} />
          ) : (
            <input className="input" aria-label="List to go through" placeholder="e.g. contact.tags" value={String(config.itemsPath ?? "")} onChange={(e) => set("itemsPath", e.target.value.trim())} />
          ))}
          <p className="text-xs text-slate-500">Stops after {JOURNEY_LIMITS.repeatIterations} rounds whatever happens. Inside the loop, conditions can use “Loop: round number” and “Loop: current item”.</p>
          {!hideNested && <>
            <p className="text-xs text-slate-400">Each round:</p>
            <StepList steps={Array.isArray(config.sequence) ? (config.sequence as BuilderStep[]) : []} onChange={(seq) => set("sequence", seq)} depth={depth + 1} lists={lists} />
          </>}
        </div>
      );
    }
    default:
      return null;
  }
}
