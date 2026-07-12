import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  toggleAutomationRule,
  deleteAutomationRule,
  updateAutomationRule,
} from "@/app/actions/automations";
import AutomationRuleForm from "@/components/AutomationRuleForm";
import ModalTrigger from "@/components/Modal";
import ConfirmDelete from "@/components/ConfirmDelete";
import { formatDateTime } from "@/lib/format";

export default async function AutomationsPage() {
  await requireUser();
  const [rules, stages, users, templates, logs, journeys] = await Promise.all([
    prisma.automationRule.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    prisma.automationLog.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.journey.findMany({
      where: { status: { not: "archived" } },
      select: { id: true, status: true },
    }),
  ]);

  const leadIds = [...new Set(logs.map((log) => log.leadId))];
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } } });
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));

  const stageName = (id: string | null) => stages.find((stage) => stage.id === id)?.name ?? "?";
  const userName = (id: string | null) => users.find((user) => user.id === id)?.name ?? "lead owner";
  const templateName = (id: string | null) => templates.find((template) => template.id === id)?.name ?? "?";

  const describeRule = (rule: (typeof rules)[number]) => {
    const when =
      rule.trigger === "lead_created"
        ? "When a new lead is created"
        : rule.trigger === "stage_entered"
          ? `When a lead enters “${stageName(rule.triggerStageId)}”`
          : rule.trigger === "lead_idle"
            ? `When a lead is untouched for ${rule.idleDays ?? 3} days`
            : `When ${rule.trigger.replaceAll("_", " ")}`;
    const then =
      rule.action === "create_activity"
        ? `schedule a ${rule.activityType ?? "to-do"} (“${rule.activitySummary || rule.name}”) due in ${rule.activityDueDays ?? 1} day(s) for ${userName(rule.assignToId)}`
        : rule.action === "send_email"
          ? `send the “${templateName(rule.emailTemplateId)}” email to the lead`
          : rule.action === "move_stage"
            ? `move the lead to “${stageName(rule.targetStageId)}”`
            : rule.action === "send_push"
              ? "notify the team"
              : `assign the lead to ${userName(rule.assignToId)}`;
    return `${when} → ${then}.`;
  };

  const activeJourneys = journeys.filter((journey) => journey.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Automations</h1>
          <p className="text-sm text-slate-400 mt-1">
            Legacy single-action rules remain available here. Use Advanced journeys for multi-step
            marketing and CRM workflows with waits, branching and versioned execution.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/journeys" className="btn-secondary">
            Advanced journeys {journeys.length > 0 ? `(${activeJourneys} active)` : ""}
          </Link>
          <ModalTrigger label="+ New legacy rule" title="New legacy automation">
            <AutomationRuleForm
              stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
              users={users.map((user) => ({ id: user.id, name: user.name }))}
              templates={templates.map((template) => ({ id: template.id, name: template.name }))}
            />
          </ModalTrigger>
        </div>
      </div>

      <div className="rounded-lg border border-orange-900/50 bg-orange-950/20 p-4">
        <p className="text-sm font-medium text-orange-300">Advanced journey engine</p>
        <p className="text-xs text-slate-400 mt-1">
          Supports email, SMS, waits, conditions, contact tags, stage changes, assignment,
          saved-segment enrollment, anniversary journeys, win-back journeys and resumable run history.
        </p>
        <Link href="/journeys" className="text-sm text-orange-400 hover:underline inline-block mt-2">
          Open journey manager →
        </Link>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Legacy rules</h2>
        {rules.length === 0 ? (
          <p className="text-sm text-slate-400 mb-4">No legacy rules configured.</p>
        ) : (
          <ul className="space-y-2 mb-5">
            {rules.map((rule) => (
              <li key={rule.id} className={`rounded-lg border border-slate-800 ${rule.active ? "" : "opacity-60"}`}>
                <div className="flex items-center gap-3 px-4 pt-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {rule.name}
                      {!rule.active && <span className="badge bg-slate-800 text-slate-400 ml-2">Paused</span>}
                    </p>
                    <p className="text-xs text-slate-400">{describeRule(rule)}</p>
                  </div>
                  <form action={toggleAutomationRule.bind(null, rule.id)}>
                    <button className="btn-secondary btn-sm">{rule.active ? "Pause" : "Resume"}</button>
                  </form>
                  <ConfirmDelete
                    action={deleteAutomationRule.bind(null, rule.id)}
                    title={`Delete automation “${rule.name}”?`}
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
                      stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
                      users={users.map((user) => ({ id: user.id, name: user.name }))}
                      templates={templates.map((template) => ({ id: template.id, name: template.name }))}
                      defaults={rule}
                      submitAction={updateAutomationRule.bind(null, rule.id)}
                      submitLabel="Save changes"
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Recent legacy runs</h2>
        {logs.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing yet — legacy runs appear here as soon as a rule fires.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {logs.map((log) => {
              const lead = leadById.get(log.leadId);
              const rule = ruleById.get(log.ruleId);
              const failed = (log.note ?? "").startsWith("error") || (log.note ?? "").includes("failed");
              return (
                <li key={log.id} className="py-2 flex items-center gap-3 text-sm">
                  <span className={failed ? "text-red-400" : "text-emerald-400"}>{failed ? "✕" : "✓"}</span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate">
                      <span className="font-medium">{rule?.name ?? "Deleted rule"}</span>{" — "}
                      {lead ? (
                        <Link href={`/leads/${lead.id}`} className="text-orange-400 hover:underline">{lead.title}</Link>
                      ) : <span className="text-slate-500">deleted lead</span>}
                    </p>
                    <p className="text-xs text-slate-400 truncate">{log.note ?? ""} · {formatDateTime(log.createdAt)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
