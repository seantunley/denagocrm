"use client";

import { useMemo, useRef, useState } from "react";
import { createJourney } from "@/app/actions/journeys";
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from "@/lib/automationCatalog";
import { BuilderSaveStatus, BuilderWorkspaceBar, BuilderWorkspaceShell } from "@/components/builder-workspace";

export type JourneyOption = { id: string; name: string };

type BuilderStep = { id: string; type: string; config: Record<string, unknown> };

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

type Props = {
  stages: JourneyOption[];
  users: JourneyOption[];
  templates: JourneyOption[];
  tags: JourneyOption[];
  segments: JourneyOption[];
  teams?: JourneyOption[];
  documentTemplates?: JourneyOption[];
  defaults?: JourneyBuilderDefaults;
  submitAction?: (formData: FormData) => Promise<void>;
  submitLabel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanSteps(defaults?: JourneyBuilderDefaults["definition"]): BuilderStep[] {
  const existing = (defaults?.steps ?? []).filter((step) => step.config?.systemGenerated !== true);
  if (!existing.length) return [{ id: "step_1", type: "create_activity", config: { activityType: "call", dueDays: 0 } }];
  return existing.map((step) => {
    const config = { ...step.config };
    if (step.type === "condition" && isRecord(config.condition)) {
      const first = Array.isArray(config.condition.conditions) && isRecord(config.condition.conditions[0]) ? config.condition.conditions[0] : null;
      if (first) Object.assign(config, { field: first.field, operator: first.operator, value: first.value });
    }
    return { id: step.id, type: step.type, config };
  });
}

function grouped<T extends { group: string }>(items: readonly T[]) {
  return [...new Set(items.map((item) => item.group))].map((group) => ({ group, items: items.filter((item) => item.group === group) }));
}

export default function JourneyBuilder({
  stages,
  users,
  templates,
  tags,
  segments,
  teams = [],
  documentTemplates = [],
  defaults = {},
  submitAction,
  submitLabel = "Save journey draft",
}: Props) {
  const counter = useRef(100);
  const [trigger, setTrigger] = useState(defaults.trigger ?? "lead_created");
  const [category, setCategory] = useState(defaults.category ?? "automation");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(defaults.triggerConfig ?? {});
  const [conditionSource, setConditionSource] = useState(defaults.conditionSource ?? "");
  const [conditionProvince, setConditionProvince] = useState(defaults.conditionProvince ?? "");
  const [minValueRands, setMinValueRands] = useState(defaults.minValueRands == null ? "" : String(defaults.minValueRands));
  const [steps, setSteps] = useState<BuilderStep[]>(cleanSteps(defaults.definition));

  const setConfig = (index: number, key: string, value: unknown) => setSteps((current) => current.map((step, i) => i === index ? { ...step, config: { ...step.config, [key]: value } } : step));
  const setType = (index: number, type: string) => {
    const initial = type === "wait" ? { amount: 1, unit: "days" }
      : type === "create_activity" || type === "create_test_drive_follow_up" ? { activityType: "call", dueDays: 0 }
      : type === "condition" ? { field: "event.status", operator: "equals", value: "" }
      : type === "set_portal_access" ? { mode: "grant", targetType: "contact", role: "viewer" }
      : {};
    setSteps((current) => current.map((step, i) => i === index ? { ...step, type, config: initial } : step));
  };
  const addStep = () => {
    counter.current += 1;
    setSteps((current) => [...current, { id: `step_${counter.current}`, type: "wait", config: { amount: 1, unit: "days" } }]);
  };
  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    setSteps((current) => { const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  };

  const entryConditions = useMemo(() => {
    const conditions: Array<Record<string, unknown>> = [];
    if (conditionSource.trim()) conditions.push({ field: "lead.source", operator: conditionSource.includes(",") ? "in" : "equals", value: conditionSource.trim() });
    if (conditionProvince.trim()) conditions.push({ field: "contact.province", operator: "equals", value: conditionProvince.trim() });
    if (minValueRands !== "") conditions.push({ field: "lead.valueCents", operator: "greater_or_equal", value: Math.round(Number(minValueRands) * 100) });
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
          condition: { logic: "and", conditions: [{ field: step.config.field, operator: step.config.operator, value: step.config.value }] },
          trueStepId: nextStepId,
          falseStepId: stopId,
        },
      };
    });
    const stops = steps.filter((step) => step.type === "condition").map((step) => ({ id: `${step.id}_false_stop`, type: "stop", nextStepId: null, config: { reason: "Condition did not match", systemGenerated: true } }));
    return { startStepId: steps[0]?.id ?? null, steps: [...mapped, ...stops] };
  }, [steps]);

  const triggerInput = (key: string, label: string, fallback: number, min = 0) => (
    <label className="block"><span className="label">{label}</span><input className="input" type="number" min={min} value={String(triggerConfig[key] ?? fallback)} onChange={(event) => setTriggerConfig((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>
  );

  return (
    <form action={submitAction ?? createJourney} className="space-y-5">
      <input type="hidden" name="triggerConfig" value={JSON.stringify(triggerConfig)} />
      <input type="hidden" name="entryConditions" value={JSON.stringify(entryConditions)} />
      <input type="hidden" name="definition" value={JSON.stringify(definition)} />
      <BuilderWorkspaceShell className="min-h-0">
        <BuilderWorkspaceBar title={defaults.name || "New journey"} description="Build durable automations across sales, test drives, stock, workshop, support, portal and integrations." status={<BuilderSaveStatus status="Unsaved changes" />}>
          <button className="btn-primary btn-sm">{submitLabel}</button>
        </BuilderWorkspaceBar>
        <div className="space-y-5 bg-[#0f1412] p-3 sm:p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <label><span className="label">Journey name</span><input name="name" className="input" required defaultValue={defaults.name ?? ""} /></label>
            <label><span className="label">Type</span><select name="category" className="input" value={category} onChange={(event) => setCategory(event.target.value)}><option value="automation">CRM automation</option><option value="marketing">Marketing journey</option></select></label>
          </div>
          <label className="block"><span className="label">Description</span><textarea name="description" className="input min-h-20" defaultValue={defaults.description ?? ""} /></label>

          <section className="space-y-3 rounded-lg border border-slate-800 p-4">
            <h3 className="font-semibold">1. Enrollment trigger</h3>
            <select name="trigger" className="input" value={trigger} onChange={(event) => { setTrigger(event.target.value); setTriggerConfig({}); }}>
              {grouped(AUTOMATION_TRIGGERS).map(({ group, items }) => <optgroup key={group} label={group}>{items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>)}
            </select>
            {trigger === "stage_entered" && <select className="input" value={String(triggerConfig.stageId ?? "")} onChange={(event) => setTriggerConfig({ stageId: event.target.value })}><option value="">Any stage</option>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>}
            {trigger === "job_stage_changed" && <input className="input" placeholder="Stage key, or blank for any" value={String(triggerConfig.stage ?? "")} onChange={(event) => setTriggerConfig({ stage: event.target.value })} />}
            {trigger === "lead_idle" && triggerInput("idleDays", "Idle days", 3, 1)}
            {trigger === "activity_overdue" && triggerInput("overdueMinutes", "Minutes overdue", 120)}
            {trigger === "quote_expiring" && triggerInput("daysBefore", "Days before quote expiry", 3)}
            {trigger === "delivery_delayed" && triggerInput("graceHours", "Grace hours after scheduled delivery", 1)}
            {trigger === "case_overdue" && <div className="grid gap-2 md:grid-cols-2">{triggerInput("hours", "Hours without resolution", 24, 1)}<label><span className="label">Priority filter</span><select className="input" value={String(triggerConfig.priority ?? "")} onChange={(event) => setTriggerConfig((current) => ({ ...current, priority: event.target.value }))}><option value="">Any priority</option><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label></div>}
            {trigger === "service_due" && <select className="input" value={String(triggerConfig.status ?? "any")} onChange={(event) => setTriggerConfig({ status: event.target.value })}><option value="any">Due soon or overdue</option><option value="due_soon">Due soon only</option><option value="overdue">Overdue only</option></select>}
            {trigger === "warranty_expiring" && triggerInput("daysBefore", "Days before warranty expiry", 30)}
            {trigger === "signature_request_stalled" && triggerInput("stalledHours", "Hours without signature", 48, 1)}
            {trigger === "xero_invoice_status_changed" && <input className="input" placeholder="Allowed Xero statuses, comma-separated; blank means any" value={String(triggerConfig.statuses ?? "")} onChange={(event) => setTriggerConfig({ statuses: event.target.value })} />}
            {trigger === "contact_segment" && <div className="grid gap-2 md:grid-cols-2"><select className="input" value={String(triggerConfig.segmentId ?? "")} onChange={(event) => setTriggerConfig((current) => ({ ...current, segmentId: event.target.value }))}><option value="">Choose segment</option>{segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}</select><select className="input" value={String(triggerConfig.repeat ?? "once")} onChange={(event) => setTriggerConfig((current) => ({ ...current, repeat: event.target.value }))}><option value="once">Once</option><option value="weekly">Weekly</option><option value="daily">Daily</option></select></div>}
            {trigger === "win_back" && triggerInput("inactiveMonths", "Inactive months", 12, 3)}
          </section>

          <details className="rounded-lg border border-slate-800 p-4">
            <summary className="cursor-pointer font-semibold">2. Optional entry filters</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-3"><label><span className="label">Lead source</span><input className="input" value={conditionSource} onChange={(event) => setConditionSource(event.target.value)} placeholder="facebook,website" /></label><label><span className="label">Province</span><input className="input" value={conditionProvince} onChange={(event) => setConditionProvince(event.target.value)} /></label><label><span className="label">Minimum lead value (R)</span><input className="input" type="number" value={minValueRands} onChange={(event) => setMinValueRands(event.target.value)} /></label></div>
          </details>

          <section className="space-y-3">
            <div className="flex items-center justify-between"><h3 className="font-semibold">3. Journey steps</h3><button type="button" className="btn-secondary btn-sm" onClick={addStep}>+ Add step</button></div>
            {steps.map((step, index) => (
              <div key={step.id} className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2"><span className="badge bg-slate-800 text-slate-300">{index + 1}</span><select className="input flex-1" value={step.type} onChange={(event) => setType(index, event.target.value)}>{grouped(AUTOMATION_ACTIONS).map(({ group, items }) => <optgroup key={group} label={group}>{items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>)}</select><button type="button" className="btn-secondary btn-sm" onClick={() => moveStep(index, -1)}>↑</button><button type="button" className="btn-secondary btn-sm" onClick={() => moveStep(index, 1)}>↓</button><button type="button" className="text-sm text-red-400" onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}>Remove</button></div>
                <StepEditor step={step} index={index} setConfig={setConfig} stages={stages} users={users} templates={templates} tags={tags} teams={teams} documentTemplates={documentTemplates} />
              </div>
            ))}
          </section>
        </div>
      </BuilderWorkspaceShell>
    </form>
  );
}

function StepEditor({ step, index, setConfig, stages, users, templates, tags, teams, documentTemplates }: { step: BuilderStep; index: number; setConfig: (index: number, key: string, value: unknown) => void; stages: JourneyOption[]; users: JourneyOption[]; templates: JourneyOption[]; tags: JourneyOption[]; teams: JourneyOption[]; documentTemplates: JourneyOption[] }) {
  const input = (key: string, placeholder: string, type = "text") => <input className="input" type={type} placeholder={placeholder} value={String(step.config[key] ?? "")} onChange={(event) => setConfig(index, key, type === "number" ? Number(event.target.value) : event.target.value)} />;
  const textarea = (key: string, placeholder: string) => <textarea className="input min-h-24" placeholder={placeholder} value={String(step.config[key] ?? "")} onChange={(event) => setConfig(index, key, event.target.value)} />;
  const userSelect = (key = "assignToId") => <select className="input" value={String(step.config[key] ?? "")} onChange={(event) => setConfig(index, key, event.target.value)}><option value="">Record owner / default user</option>{users.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;

  if (step.type === "send_email") return <div className="space-y-2"><select className="input" value={String(step.config.emailTemplateId ?? "")} onChange={(event) => setConfig(index, "emailTemplateId", event.target.value)}><option value="">Write message below</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{input("subject", "Email subject")}{textarea("body", "Email body; use {{first_name}}, {{name}}, {{model}}, {{event_reference}}")}</div>;
  if (["send_sms", "send_whatsapp", "send_push"].includes(step.type)) return textarea("message", `${step.type.replaceAll("_", " ")} message`);
  if (step.type === "send_portal_notification") return <div className="grid gap-2 md:grid-cols-2">{input("title", "Notification title")}{input("href", "/portal") }<div className="md:col-span-2">{textarea("message", "Notification message")}</div></div>;
  if (step.type === "wait") return <div className="grid grid-cols-2 gap-2">{input("amount", "Amount", "number")}<select className="input" value={String(step.config.unit ?? "days")} onChange={(event) => setConfig(index, "unit", event.target.value)}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></div>;
  if (["create_activity", "create_test_drive_follow_up"].includes(step.type)) return <div className="grid gap-2 md:grid-cols-4"><select className="input" value={String(step.config.activityType ?? "call")} onChange={(event) => setConfig(index, "activityType", event.target.value)}><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="whatsapp">WhatsApp</option><option value="todo">To-do</option></select><div className="md:col-span-2">{input("summary", "Activity summary")}</div>{input("dueDays", "Due days", "number")}<div className="md:col-span-4">{userSelect()}</div></div>;
  if (step.type === "create_workshop_booking") return <div className="grid gap-2 md:grid-cols-2">{input("summary", "Booking summary")}{input("dueHours", "Hours from now", "number")}{input("branch", "Workshop / branch")}{userSelect()}</div>;
  if (step.type === "create_case") return <div className="grid gap-2 md:grid-cols-2">{input("subject", "Case subject")}<select className="input" value={String(step.config.priority ?? "normal")} onChange={(event) => setConfig(index, "priority", event.target.value)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select><div className="md:col-span-2">{textarea("description", "Case description")}</div>{userSelect()}</div>;
  if (step.type === "create_job_card") return <div className="grid gap-2 md:grid-cols-2">{input("vehicleId", "Vehicle ID; blank uses event vehicle")}{input("description", "Work description")}{userSelect("technicianId")}</div>;
  if (step.type === "move_stage") return <select className="input" value={String(step.config.stageId ?? "")} onChange={(event) => setConfig(index, "stageId", event.target.value)}><option value="">Choose stage</option>{stages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;
  if (step.type === "assign_user") return userSelect("userId");
  if (step.type === "assign_team") return teams.length ? <select className="input" value={String(step.config.teamId ?? "")} onChange={(event) => setConfig(index, "teamId", event.target.value)}><option value="">Choose team</option>{teams.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : input("teamId", "Team ID");
  if (step.type === "assign_branch") return input("branch", "Branch / location");
  if (["add_tag", "remove_tag"].includes(step.type)) return <select className="input" value={String(step.config.tagId ?? "")} onChange={(event) => setConfig(index, "tagId", event.target.value)}><option value="">Choose tag</option>{tags.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;
  if (step.type === "update_field") return <div className="grid gap-2 md:grid-cols-2"><select className="input" value={String(step.config.field ?? "")} onChange={(event) => setConfig(index, "field", event.target.value)}><option value="">Choose safe field</option><option value="lead.source">Lead source</option><option value="lead.valueCents">Lead value (cents)</option><option value="lead.quantity">Lead quantity</option><option value="contact.source">Contact source</option><option value="contact.province">Contact province</option><option value="contact.marketingOptOut">Marketing opt-out</option><option value="case.priority">Case priority</option><option value="testDrive.branch">Test-drive branch</option><option value="testDrive.intendedRoute">Test-drive route</option></select>{input("value", "New value")}</div>;
  if (step.type === "escalate_to_manager") return <div className="grid gap-2 md:grid-cols-2">{input("summary", "Escalation summary")}{textarea("note", "Escalation note")}</div>;
  if (step.type === "create_stock_transfer") return <div className="grid gap-2 md:grid-cols-2">{input("stockUnitId", "Stock unit ID; blank uses event")}{input("toBranch", "Destination branch")}</div>;
  if (["generate_document", "create_signing_request"].includes(step.type)) return <div className="grid gap-2 md:grid-cols-2">{documentTemplates.length ? <select className="input" value={String(step.config.templateId ?? "")} onChange={(event) => setConfig(index, "templateId", event.target.value)}><option value="">Choose template</option>{documentTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : input("templateId", "Document template ID")}{input("title", "Document / request title")}</div>;
  if (step.type === "request_internal_approval") return <div className="grid gap-2 md:grid-cols-2">{input("title", "Approval title")}{userSelect()}<div className="md:col-span-2">{textarea("description", "Approval description")}</div></div>;
  if (step.type === "call_webhook") return <div className="grid gap-2 md:grid-cols-2">{input("url", "HTTPS webhook URL")}{input("secret", "Optional signing secret")}</div>;
  if (step.type === "create_xero_draft_invoice") return input("quoteId", "Quote ID; blank uses event quote");
  if (step.type === "set_portal_access") return <div className="grid gap-2 md:grid-cols-3"><select className="input" value={String(step.config.mode ?? "grant")} onChange={(event) => setConfig(index, "mode", event.target.value)}><option value="grant">Grant / update</option><option value="revoke">Revoke</option></select><select className="input" value={String(step.config.targetType ?? "contact")} onChange={(event) => setConfig(index, "targetType", event.target.value)}><option value="contact">Contact</option><option value="fleet">Fleet</option></select><select className="input" value={String(step.config.role ?? "viewer")} onChange={(event) => setConfig(index, "role", event.target.value)}><option value="viewer">Viewer</option><option value="manager">Manager</option><option value="owner">Owner</option></select>{input("viewerContactId", "Viewer contact ID; blank uses contact")}{input("targetId", "Target ID; blank uses contact")}</div>;
  if (step.type === "condition") return <div className="grid gap-2 md:grid-cols-3"><input className="input" list="condition-fields" value={String(step.config.field ?? "event.status")} onChange={(event) => setConfig(index, "field", event.target.value)} /><datalist id="condition-fields"><option value="lead.source"/><option value="lead.status"/><option value="lead.valueCents"/><option value="contact.province"/><option value="contact.tags"/><option value="event.status"/><option value="event.priority"/><option value="event.stage"/><option value="event.hoursOverdue"/><option value="source.model"/></datalist><select className="input" value={String(step.config.operator ?? "equals")} onChange={(event) => setConfig(index, "operator", event.target.value)}><option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="contains">Contains</option><option value="greater_or_equal">At least</option><option value="less_or_equal">At most</option><option value="is_empty">Is empty</option><option value="is_not_empty">Is not empty</option></select>{input("value", "Value")}</div>;
  if (step.type === "stop") return input("reason", "Reason");
  return <p className="text-xs text-slate-500">This step uses its defaults and the current event context.</p>;
}
