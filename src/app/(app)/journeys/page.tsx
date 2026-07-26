import Link from "next/link";
import { Activity, Workflow } from "lucide-react";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { listTenantStaff } from "@/lib/tenantActor";
import { SCHEDULED_AUTOMATION_TRIGGERS, triggerLabel } from "@/lib/automationCatalog";
import JourneyBuilder, { type JourneyBuilderDefaults } from "@/components/JourneyBuilder";
import {
  installJourneyTemplates,
  publishJourney,
  saveJourneyDraft,
  setJourneyStatus,
} from "@/app/actions/journeys";
import {
  cancelJourneyRun,
  retryJourneyRun,
  runJourneyNowAction,
} from "@/app/actions/journeyRuns";
import { PageHeader } from "@/components/page-header";
import { EmptyState, FeedbackBanner, StatusPill } from "@/components/visual-system";

export const dynamic = "force-dynamic";

function record(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function defaultsFor(
  journey: { name: string; description: string | null; category: string },
  version: {
    trigger: string;
    triggerConfig: Prisma.JsonValue | null;
    entryConditions: Prisma.JsonValue | null;
    definition: Prisma.JsonValue;
  }
): JourneyBuilderDefaults {
  const group = record(version.entryConditions);
  const conditions = Array.isArray(group.conditions)
    ? group.conditions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const find = (field: string) => conditions.find((condition) => condition.field === field)?.value;
  const minCents = Number(find("lead.valueCents"));
  return {
    name: journey.name,
    description: journey.description,
    category: journey.category,
    trigger: version.trigger,
    triggerConfig: record(version.triggerConfig),
    conditionSource: String(find("lead.source") ?? ""),
    conditionProvince: String(find("contact.province") ?? ""),
    minValueRands: Number.isFinite(minCents) ? minCents / 100 : null,
    definition: version.definition as unknown as JourneyBuilderDefaults["definition"],
  };
}

function statusTone(status: string) {
  if (status === "active" || status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "paused" || status === "waiting") return "warning" as const;
  if (status === "draft") return "info" as const;
  return "neutral" as const;
}

export default async function JourneysPage() {
  await requireOwner();
  const [journeys, stages, staff, templates, tags, segments, teams, documentTemplates, recentRuns, lifecycleSettings] = await Promise.all([
    prisma.journey.findMany({
      where: { status: { not: "archived" } },
      orderBy: { updatedAt: "desc" },
      include: { versions: { orderBy: { version: "desc" } }, _count: { select: { runs: true } } },
    }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    listTenantStaff(),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.tag.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.segment.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.team.findMany({ where: { active: true, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.customDocTemplate.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.journeyRun.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { journey: true, journeyVersion: true } }),
    prisma.appSetting.findMany({ where: { key: { in: ["LIFECYCLE_ANNIVERSARY_ENABLED", "LIFECYCLE_WINBACK_ENABLED"] } } }),
  ]);
  const users = staff.map(({ id, name }) => ({ id, name }));
  const options = { stages, users, templates, tags, segments, teams, documentTemplates };
  const legacyLifecycleEnabled = lifecycleSettings.some((setting) => setting.value === "true");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/automations" className="transition-colors hover:text-primary">Automations</Link>
        <span>/</span><span>Journeys</span>
      </div>
      <PageHeader
        title="Cross-module Journeys"
        description="Versioned workflows across CRM, test drives, quotes, stock, delivery, workshop, warranty, support, portal, documents and integrations."
      >
        <form action={installJourneyTemplates}><button className="btn-secondary">Install recommended drafts</button></form>
      </PageHeader>

      {legacyLifecycleEnabled && (
        <FeedbackBanner tone="warning" title="Legacy lifecycle emails are still enabled">
          Disable the old anniversary and win-back toggles in Settings before activating equivalent Journeys, otherwise customers could receive both versions.
        </FeedbackBanner>
      )}

      <details className="card" open={journeys.length === 0}>
        <summary className="cursor-pointer font-semibold">+ Create a journey</summary>
        <div className="mt-5"><JourneyBuilder {...options} /></div>
      </details>

      <section className="space-y-3">
        <h2 className="font-semibold">Journey library</h2>
        {journeys.length === 0 ? (
          <EmptyState icon={Workflow} title="No journeys configured" description="Install the recommended drafts for a guided start, or create a Journey with your own cross-module trigger and actions." />
        ) : journeys.map((journey) => {
          const draft = journey.versions.find((version) => version.state === "draft");
          const published = journey.versions.find((version) => version.version === journey.activeVersion);
          const editable = draft ?? published ?? journey.versions[0];
          return (
            <article key={journey.id} className="card space-y-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-64 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{journey.name}</h3>
                    <StatusPill tone={statusTone(journey.status)}>{journey.status}</StatusPill>
                    <StatusPill>{journey.category}</StatusPill>
                    {draft && <StatusPill tone="info">draft v{draft.version}</StatusPill>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{journey.description || "No description"}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Trigger: {triggerLabel((published ?? editable)?.trigger ?? "unknown")} · Active version: {journey.activeVersion ?? "none"} · Runs: {journey._count.runs}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {draft && <form action={publishJourney.bind(null, journey.id)}><button className="btn-primary btn-sm">Publish v{draft.version}</button></form>}
                  {journey.status === "active" ? (
                    <form action={setJourneyStatus.bind(null, journey.id, "paused")}><button className="btn-secondary btn-sm">Pause</button></form>
                  ) : journey.activeVersion ? (
                    <form action={setJourneyStatus.bind(null, journey.id, "active")}><button className="btn-secondary btn-sm">Resume</button></form>
                  ) : null}
                  {journey.status === "active" && SCHEDULED_AUTOMATION_TRIGGERS.has((published?.trigger ?? "") as never) && (
                    <form action={runJourneyNowAction.bind(null, journey.id)}><button className="btn-secondary btn-sm">Evaluate now</button></form>
                  )}
                  <form action={setJourneyStatus.bind(null, journey.id, "archived")}><button className="px-2 py-1 text-xs text-red-400">Archive</button></form>
                </div>
              </div>

              {editable && (
                <details className="rounded-lg border border-border p-4">
                  <summary className="cursor-pointer text-sm font-medium text-primary">Edit {draft ? `draft v${draft.version}` : "as a new draft"}</summary>
                  <div className="mt-5">
                    <JourneyBuilder {...options} defaults={defaultsFor(journey, editable)} submitAction={saveJourneyDraft.bind(null, journey.id)} submitLabel="Save draft" />
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </section>

      <section className="card">
        <h2 className="mb-4 font-semibold">Recent journey runs</h2>
        {recentRuns.length === 0 ? (
          <EmptyState icon={Activity} title="No journey runs yet" description="Execution history appears here after an active Journey enrols a record or system event." className="py-8" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Journey</th><th>Record</th><th>Version</th><th>Status</th><th>Current step</th><th>Started</th><th>Error</th><th>Actions</th></tr></thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td className="font-medium">{run.journey.name}</td>
                    <td>{run.leadId ? <Link className="text-primary hover:underline" href={`/leads/${run.leadId}`}>Lead</Link> : run.contactId ? <Link className="text-primary hover:underline" href={`/contacts/${run.contactId}`}>Contact</Link> : run.entityType}</td>
                    <td>v{run.journeyVersion.version}</td>
                    <td><StatusPill tone={statusTone(run.status)}>{run.status}</StatusPill></td>
                    <td className="text-xs text-muted-foreground">{run.currentStepId ?? "—"}</td>
                    <td className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</td>
                    <td className="max-w-64 truncate text-xs text-red-300">{run.lastError ?? "—"}</td>
                    <td><div className="flex gap-2">{["failed", "cancelled"].includes(run.status) && <form action={retryJourneyRun.bind(null, run.id)}><button className="btn-secondary btn-sm">Retry</button></form>}{["queued", "waiting"].includes(run.status) && <form action={cancelJourneyRun.bind(null, run.id)}><button className="text-xs text-red-400">Cancel</button></form>}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
