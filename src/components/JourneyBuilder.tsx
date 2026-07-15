"use client";

import { useMemo, useRef, useState } from "react";
import { createJourney } from "@/app/actions/journeys";
import { BuilderSaveStatus, BuilderWorkspaceBar, BuilderWorkspaceShell } from "@/components/builder-workspace";

export type JourneyOption = { id: string; name: string };

type BuilderStep = {
  id: string;
  type: string;
  config: Record<string, unknown>;
};

export type JourneyBuilderDefaults = {
  name?: string;
  description?: string | null;
  category?: string;
  trigger?: string;
  triggerConfig?: Record<string, unknown> | null;
  conditionSource?: string;
  conditionProvince?: string;
  minValueRands?: number | null;
  definition?: { startStepId?: string | null; steps?: BuilderStep[] } | null;
};

const stepLabels: Record<string, string> = {
  send_email: "Send email",
  send_sms: "Send SMS",
  create_activity: "Create activity",
  send_push: "Notify the team",
  move_stage: "Move lead stage",
  assign_user: "Assign lead",
  add_tag: "Add contact tag",
  remove_tag: "Remove contact tag",
  wait: "Wait",
  condition: "Condition / branch",
  stop: "Stop journey",
};

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
    return { id: step.id, type: step.type, config };
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
  const [trigger, setTrigger] = useState(defaults.trigger ?? "lead_created");
  const [category, setCategory] = useState(defaults.category ?? "automation");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(
    defaults.triggerConfig ?? {}
  );
  const [conditionSource, setConditionSource] = useState(defaults.conditionSource ?? "");
  const [conditionProvince, setConditionProvince] = useState(defaults.conditionProvince ?? "");
  const [minValueRands, setMinValueRands] = useState(
    defaults.minValueRands == null ? "" : String(defaults.minValueRands)
  );
  const [steps, setSteps] = useState<BuilderStep[]>(cleanSteps(defaults.definition));

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
      if (step.type !== "condition") return { ...step, nextStepId };
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
    const generatedStops = steps
      .filter((step) => step.type === "condition")
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
      <input type="hidden" name="triggerConfig" value={JSON.stringify(triggerConfig)} />
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
        <h3 className="font-semibold">1. Enrollment trigger</h3>
        <select name="trigger" className="input" value={trigger} onChange={(e) => { setTrigger(e.target.value); setTriggerConfig({}); }}>
          <option value="lead_created">New lead created</option>
          <option value="stage_entered">Lead enters a stage</option>
          <option value="lead_idle">Lead becomes idle</option>
          <option value="lead_won">Lead is won</option>
          <option value="lead_lost">Lead is lost</option>
          <option value="quote_signed">Quote is signed</option>
          <option value="quote_declined">Quote is declined</option>
          <option value="delivered">Vehicle is delivered</option>
          <option value="referral_earned">Referral is earned</option>
          <option value="contact_segment">Contact joins a saved segment</option>
          <option value="purchase_anniversary">Purchase anniversary</option>
          <option value="win_back">Inactive customer win-back</option>
        </select>

        {trigger === "stage_entered" && (
          <select className="input" value={String(triggerConfig.stageId ?? "")} onChange={(e) => setTriggerConfig({ stageId: e.target.value })}>
            <option value="">Any stage</option>
            {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
          </select>
        )}
        {trigger === "lead_idle" && (
          <input className="input" type="number" min={1} value={String(triggerConfig.idleDays ?? 3)} onChange={(e) => setTriggerConfig({ idleDays: Number(e.target.value) })} aria-label="Idle days" />
        )}
        {trigger === "contact_segment" && (
          <div className="grid md:grid-cols-2 gap-2">
            <select className="input" value={String(triggerConfig.segmentId ?? "")} onChange={(e) => setTriggerConfig((current) => ({ ...current, segmentId: e.target.value }))}>
              <option value="">Choose segment</option>
              {segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
            </select>
            <select className="input" value={String(triggerConfig.repeat ?? "once")} onChange={(e) => setTriggerConfig((current) => ({ ...current, repeat: e.target.value }))}>
              <option value="once">Enroll each contact once</option>
              <option value="weekly">Allow weekly re-enrollment</option>
              <option value="daily">Allow daily re-enrollment</option>
            </select>
          </div>
        )}
        {trigger === "win_back" && (
          <input className="input" type="number" min={3} value={String(triggerConfig.inactiveMonths ?? 12)} onChange={(e) => setTriggerConfig({ inactiveMonths: Number(e.target.value) })} aria-label="Inactive months" />
        )}
      </div>

      <details className="rounded-lg border border-slate-800 p-4">
        <summary className="font-semibold cursor-pointer">2. Optional entry filters</summary>
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
          <h3 className="font-semibold">3. Journey steps</h3>
          <button type="button" className="btn-secondary btn-sm" onClick={addStep}>+ Add step</button>
        </div>
        {steps.map((step, index) => (
          <div key={step.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="badge bg-slate-800 text-slate-300">{index + 1}</span>
              <select className="input flex-1" value={step.type} onChange={(e) => setType(index, e.target.value)}>
                {Object.entries(stepLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" className="btn-secondary btn-sm" onClick={() => moveStep(index, -1)}>↑</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => moveStep(index, 1)}>↓</button>
              <button type="button" className="text-red-400 text-sm" onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}>Remove</button>
            </div>

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
            {step.type === "condition" && (
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
          </div>
        ))}
      </div>

        </div>
      </BuilderWorkspaceShell>
    </form>
  );
}
