"use client";

import { useState } from "react";
import { createAutomationRule } from "@/app/actions/automations";

type Option = { id: string; name: string };

export type RuleDefaults = {
  name?: string;
  trigger?: string;
  triggerStageId?: string | null;
  idleDays?: number | null;
  action?: string;
  activityType?: string | null;
  activitySummary?: string | null;
  activityDueDays?: number | null;
  emailTemplateId?: string | null;
  targetStageId?: string | null;
  assignToId?: string | null;
};

export default function AutomationRuleForm({
  stages,
  users,
  templates,
  defaults = {},
  submitAction,
  submitLabel = "Add automation",
}: {
  stages: Option[];
  users: Option[];
  templates: Option[];
  defaults?: RuleDefaults;
  submitAction?: (formData: FormData) => Promise<void>;
  submitLabel?: string;
}) {
  const [trigger, setTrigger] = useState(defaults.trigger ?? "lead_created");
  const [action, setAction] = useState(defaults.action ?? "create_activity");

  return (
    <form
      action={submitAction ?? createAutomationRule}
      className="rounded-lg bg-slate-800/40 p-4 border border-slate-800 space-y-3"
    >
      <div>
        <label className="label">Rule name</label>
        <input
          name="name"
          className="input"
          required
          defaultValue={defaults.name ?? ""}
          placeholder="e.g. Follow up new Facebook leads within a day"
        />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="space-y-3">
          <div>
            <label className="label">When…</label>
            <select
              name="trigger"
              className="input"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
            >
              <option value="lead_created">A new lead is created</option>
              <option value="stage_entered">A lead enters a stage</option>
              <option value="lead_idle">A lead sits untouched</option>
            </select>
          </div>
          {trigger === "stage_entered" && (
            <div>
              <label className="label">Stage</label>
              <select
                name="triggerStageId"
                className="input"
                required
                defaultValue={defaults.triggerStageId ?? ""}
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {trigger === "lead_idle" && (
            <div>
              <label className="label">Untouched for (days)</label>
              <input
                name="idleDays"
                type="number"
                className="input"
                defaultValue={defaults.idleDays ?? 3}
                min={1}
                required
              />
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Then…</label>
            <select
              name="action"
              className="input"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="create_activity">Schedule an activity</option>
              <option value="send_email">Send an email template to the lead</option>
              <option value="move_stage">Move the lead to a stage</option>
              <option value="assign_user">Assign the lead to a team member</option>
            </select>
          </div>

          {action === "create_activity" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Activity type</label>
                  <select
                    name="activityType"
                    className="input"
                    defaultValue={defaults.activityType ?? "call"}
                  >
                    <option value="call">Call</option>
                    <option value="email">Email</option>
                    <option value="meeting">Meeting</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="todo">To-do</option>
                  </select>
                </div>
                <div>
                  <label className="label">Due in (days)</label>
                  <input
                    name="activityDueDays"
                    type="number"
                    className="input"
                    defaultValue={defaults.activityDueDays ?? 1}
                    min={0}
                  />
                </div>
              </div>
              <div>
                <label className="label">Activity summary</label>
                <input
                  name="activitySummary"
                  className="input"
                  defaultValue={defaults.activitySummary ?? ""}
                  placeholder="e.g. Call the new lead"
                />
              </div>
              <div>
                <label className="label">Assign to (optional — defaults to lead owner)</label>
                <select
                  name="assignToId"
                  className="input"
                  defaultValue={defaults.assignToId ?? ""}
                >
                  <option value="">Lead owner / first user</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {action === "send_email" && (
            <div>
              <label className="label">Email template</label>
              {templates.length === 0 ? (
                <p className="text-xs text-amber-300">
                  Create an email template first (Settings → Email templates).
                </p>
              ) : (
                <select
                  name="emailTemplateId"
                  className="input"
                  required
                  defaultValue={defaults.emailTemplateId ?? ""}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {action === "move_stage" && (
            <div>
              <label className="label">Target stage</label>
              <select
                name="targetStageId"
                className="input"
                required
                defaultValue={defaults.targetStageId ?? ""}
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {action === "assign_user" && (
            <div>
              <label className="label">Assign to</label>
              <select
                name="assignToId"
                className="input"
                required
                defaultValue={defaults.assignToId ?? ""}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <button className="btn-primary">{submitLabel}</button>
    </form>
  );
}
