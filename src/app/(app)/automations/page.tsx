import Link from "next/link";
import { Activity, Clock3, PauseCircle, PlayCircle, Plus, Workflow, XCircle } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  toggleAutomationRule,
  deleteAutomationRule,
  updateAutomationRule,
} from "@/app/actions/automations";
import { saveNextStepScheduling } from "@/app/actions/settings";
import { getNextStepScheduling } from "@/lib/nextStepConfig";
import AutomationRuleForm from "@/components/AutomationRuleForm";
import ModalTrigger from "@/components/Modal";
import ConfirmDelete from "@/components/ConfirmDelete";
import { formatDateTime } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";

export default async function AutomationsPage() {
  const user = await requireUser();
  const [rules, stages, users, templates, logs, scheduling] = await Promise.all([
    prisma.automationRule.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    prisma.automationLog.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
    getNextStepScheduling(),
  ]);
  const isOwner = user.role === "owner";

  const leadIds = [...new Set(logs.map((l) => l.leadId))];
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } } });
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const activeRules = rules.filter((rule) => rule.active).length;
  const failedRuns = logs.filter((log) => (log.note ?? "").startsWith("error") || (log.note ?? "").includes("failed")).length;

  const stageName = (id: string | null) => stages.find((s) => s.id === id)?.name ?? "?";
  const userName = (id: string | null) => users.find((u) => u.id === id)?.name ?? "lead owner";
  const templateName = (id: string | null) => templates.find((t) => t.id === id)?.name ?? "?";

  const describeRule = (r: (typeof rules)[number]) => {
    const when =
      r.trigger === "lead_created"
        ? "When a new lead is created"
        : r.trigger === "stage_entered"
        ? `When a lead enters “${stageName(r.triggerStageId)}”`
        : `When a lead is untouched for ${r.idleDays ?? 3} days`;
    const then =
      r.action === "create_activity"
        ? `schedule a ${r.activityType ?? "to-do"} (“${r.activitySummary || r.name}”) due in ${
            r.activityDueDays ?? 1
          } day(s) for ${userName(r.assignToId)}`
        : r.action === "send_email"
        ? `send the “${templateName(r.emailTemplateId)}” email to the lead`
        : r.action === "move_stage"
        ? `move the lead to “${stageName(r.targetStageId)}”`
        : `assign the lead to ${userName(r.assignToId)}`;
    return `${when} → ${then}.`;
  };

  return (
    <div className="space-y-6">
      <WorkspaceHero icon={Workflow} eyebrow="Operations" title="Automations" description="Turn repeatable sales work into dependable workflows, with clear controls and a visible run history."
        stats={[
          { label: "Active rules", value: activeRules, icon: PlayCircle, tone: "success" },
          { label: "Paused", value: rules.length - activeRules, icon: PauseCircle },
          { label: "Recent runs", value: logs.length, icon: Activity },
          { label: "Needs attention", value: failedRuns, icon: XCircle, tone: failedRuns ? "danger" : "default" },
        ]}
        actions={<ModalTrigger label={<><Plus className="size-4" />New automation</>} title="New automation" buttonClass={buttonVariants({ size: "sm" })}>
          <AutomationRuleForm
            stages={stages.map((s) => ({ id: s.id, name: s.name }))}
            users={users.map((u) => ({ id: u.id, name: u.name }))}
            templates={templates.map((t) => ({ id: t.id, name: t.name }))}
          />
        </ModalTrigger>}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <Surface className="p-5">
        <SectionHeading title="Workflow rules" description="Every active rule listens for its trigger and completes the next step automatically." />
        {rules.length === 0 ? (
          <EmptyState icon={Workflow} title="Build your first automation" description="Choose a trigger and action to remove a repetitive step from your team's day." />
        ) : (
          <ul className="mt-4 space-y-3">
            {rules.map((r) => (
              <li
                key={r.id}
                className={`rounded-xl border border-border bg-muted/20 ${r.active ? "" : "opacity-65"}`}
              >
                <div className="flex items-center gap-3 px-4 pt-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {r.name}
                      <StatusPill className="ml-2" tone={r.active ? "success" : "neutral"}>{r.active ? "Running" : "Paused"}</StatusPill>
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{describeRule(r)}</p>
                  </div>
                  <form action={toggleAutomationRule.bind(null, r.id)}>
                    <button className="btn-secondary btn-sm">
                      {r.active ? "Pause" : "Resume"}
                    </button>
                  </form>
                  <ConfirmDelete
                    action={deleteAutomationRule.bind(null, r.id)}
                    title={`Delete automation “${r.name}”?`}
                    description="This cannot be undone. Its run history is removed too."
                    trigger="✕"
                    triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                  />
                </div>
                <details>
                  <summary className="px-4 py-2 text-xs font-medium text-orange-400 cursor-pointer hover:underline list-none [&::-webkit-details-marker]:hidden">
                    ✎ Edit rule
                  </summary>
                  <div className="px-4 pb-4">
                    <AutomationRuleForm
                      stages={stages.map((s) => ({ id: s.id, name: s.name }))}
                      users={users.map((u) => ({ id: u.id, name: u.name }))}
                      templates={templates.map((t) => ({ id: t.id, name: t.name }))}
                      defaults={r}
                      submitAction={updateAutomationRule.bind(null, r.id)}
                      submitLabel="Save changes"
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Surface>

      {isOwner && (
        <Surface className="p-5 xl:sticky xl:top-5">
          <Clock3 className="mb-3 size-5 text-primary" />
          <h2 className="font-semibold mb-1">Next-step scheduling</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Controls when auto-created follow-up tasks are due.
          </p>
          <form
            action={saveNextStepScheduling}
            className="grid gap-4"
          >
            <div>
              <label className="label" htmlFor="nss-hour">
                Work-hour for follow-ups
              </label>
              <select
                id="nss-hour"
                name="hour"
                className="input"
                defaultValue={String(scheduling.hour)}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {`${String(h).padStart(2, "0")}:00`}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                name="skipWeekends"
                defaultChecked={scheduling.skipWeekends}
                className="size-4 rounded border-slate-700 bg-slate-900 accent-orange-500"
              />
              Skip weekends (roll to Monday)
            </label>
            <div>
              <button className="btn-primary">Save scheduling</button>
            </div>
          </form>
        </Surface>
      )}
      </div>

      <Surface className="p-5">
        <SectionHeading title="Recent runs" description="A live audit trail of completed and failed automation activity." />
        {logs.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nothing yet — runs appear here as soon as a rule fires.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {logs.map((log) => {
              const lead = leadById.get(log.leadId);
              const rule = ruleById.get(log.ruleId);
              const failed = (log.note ?? "").startsWith("error") || (log.note ?? "").includes("failed");
              return (
                <li key={log.id} className="py-2 flex items-center gap-3 text-sm">
                  <span className={`grid size-7 shrink-0 place-items-center rounded-full ${failed ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                    {failed ? "✕" : "✓"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate">
                      <span className="font-medium">{rule?.name ?? "Deleted rule"}</span>
                      {" — "}
                      {lead ? (
                        <Link href={`/leads/${lead.id}`} className="text-orange-400 hover:underline">
                          {lead.title}
                        </Link>
                      ) : (
                        <span className="text-slate-500">deleted lead</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-400 truncate">
                      {log.note ?? ""} · {formatDateTime(log.createdAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>
    </div>
  );
}
