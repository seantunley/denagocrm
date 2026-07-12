import Link from "next/link";
import { Plus } from "lucide-react";
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
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";

export default async function AutomationsPage() {
  await requireUser();
  const [rules, stages, users, templates, logs] = await Promise.all([
    prisma.automationRule.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    prisma.automationLog.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
  ]);

  const leadIds = [...new Set(logs.map((l) => l.leadId))];
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } } });
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));

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
      <PageHeader title="Automations" description={`${rules.length} workflow rule${rules.length === 1 ? "" : "s"} · Lead, quote, delivery and referral triggers.`}>
        <ModalTrigger label={<><Plus className="size-4" />New automation</>} title="New automation" buttonClass={buttonVariants({ size: "sm" })}>
          <AutomationRuleForm
            stages={stages.map((s) => ({ id: s.id, name: s.name }))}
            users={users.map((u) => ({ id: u.id, name: u.name }))}
            templates={templates.map((t) => ({ id: t.id, name: t.name }))}
          />
        </ModalTrigger>
      </PageHeader>

      <div className="card">
        <h2 className="font-semibold mb-4">Rules</h2>
        {rules.length === 0 ? (
          <p className="text-sm text-slate-400 mb-4">No rules yet — click “+ New automation” to create your first.</p>
        ) : (
          <ul className="space-y-2 mb-5">
            {rules.map((r) => (
              <li
                key={r.id}
                className={`rounded-lg border border-slate-800 ${r.active ? "" : "opacity-60"}`}
              >
                <div className="flex items-center gap-3 px-4 pt-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {r.name}
                      {!r.active && (
                        <span className="badge bg-slate-800 text-slate-400 ml-2">Paused</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-400">{describeRule(r)}</p>
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
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Recent runs</h2>
        {logs.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nothing yet — runs appear here as soon as a rule fires.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {logs.map((log) => {
              const lead = leadById.get(log.leadId);
              const rule = ruleById.get(log.ruleId);
              const failed = (log.note ?? "").startsWith("error") || (log.note ?? "").includes("failed");
              return (
                <li key={log.id} className="py-2 flex items-center gap-3 text-sm">
                  <span className={failed ? "text-red-400" : "text-emerald-400"}>
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
      </div>
    </div>
  );
}
