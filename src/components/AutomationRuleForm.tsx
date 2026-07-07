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
  pushMessage?: string | null;
  conditionSources?: string | null;
  minValueCents?: number | null;
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
              <option value="lead_won">A lead is won</option>
              <option value="lead_lost">A lead is lost</option>
              <option value="quote_signed">A quote is signed online</option>
              <option value="quote_declined">A quote is declined online</option>
              <option value="delivered">A cart is delivered</option>
              <option value="referral_earned">A referral fee is earned</option>
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

          <details className="rounded-lg border border-slate-800 bg-slate-900/50">
            <summary className="px-3 py-2 text-xs font-medium text-slate-400 cursor-pointer select-none">
              Only if… (optional conditions)
            </summary>
            <div className="p-3 pt-1 space-y-2">
              <div>
                <label className="label">Lead source is one of (comma-separated)</label>
                <input
                  name="conditionSources"
                  className="input"
                  defaultValue={defaults.conditionSources ?? ""}
                  placeholder="e.g. facebook,instagram — blank = any"
                />
              </div>
              <div>
                <label className="label">Lead value at least (R)</label>
                <input
                  name="minValueRands"
                  type="number"
                  className="input"
                  defaultValue={
                    defaults.minValueCents != null ? Math.round(defaults.minValueCents / 100) : ""
                  }
                  placeholder="blank = any value"
                />
              </div>
            </div>
          </details>
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
              <option value="send_push">Send the team a push notification</option>
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

          {action === "send_push" && (
            <div>
              <label className="label">Notification message</label>
              <input
                name="pushMessage"
                className="input"
                defaultValue={defaults.pushMessage ?? ""}
                placeholder="e.g. {{name}} ({{model}}) needs attention"
              />
              <p className="text-xs text-slate-500 mt-1">
                Placeholders: {"{{name}}"}, {"{{model}}"}, {"{{value}}"}
              </p>
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
