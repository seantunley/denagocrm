import Link from "next/link";
import { Activity, Workflow } from "lucide-react";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import JourneyBuilder, { type JourneyBuilderDefaults } from "@/components/JourneyBuilder";
import JourneyTestRun from "@/components/JourneyTestRun";
import { parseRunMode } from "@/lib/journeyArbitration";
import { JOURNEY_RUN_MODE_COPY } from "@/lib/journeyRunModes";
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
import { EmptyState, StatusPill } from "@/components/visual-system";

export const dynamic = "force-dynamic";

function record(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function defaultsFor(
  journey: { name: string; description: string | null; category: string; runMode: string },
  version: {
    trigger: string;
    triggerConfig: Prisma.JsonValue | null;
    entryConditions: Prisma.JsonValue | null;
    definition: Prisma.JsonValue;
  }
): JourneyBuilderDefaults {
  const group = record(version.entryConditions);
  const conditions = Array.isArray(group.conditions)
    ? group.conditions.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const find = (field: string) => conditions.find((condition) => condition.field === field)?.value;
  const minCents = Number(find("lead.valueCents"));
  return {
    name: journey.name,
    description: journey.description,
    category: journey.category,
    // Through parseRunMode, not raw: the editor must show what the ENGINE will
    // do with the stored string, and an unrecognised value runs as "single".
    runMode: parseRunMode(journey.runMode),
    trigger: version.trigger,
    triggerConfig: record(version.triggerConfig),
    conditionSource: String(find("lead.source") ?? ""),
    conditionProvince: String(find("contact.province") ?? ""),
    minValueRands: Number.isFinite(minCents) ? minCents / 100 : null,
    definition: version.definition as unknown as JourneyBuilderDefaults["definition"],
  };
}

function triggerLabel(trigger: string) {
  return trigger.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
  const [journeys, stages, users, templates, tags, segments, recentRuns, testLeads] = await Promise.all([
    prisma.journey.findMany({
      where: { status: { not: "archived" } },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: { orderBy: { version: "desc" } },
        _count: { select: { runs: true } },
      },
    }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.tag.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.segment.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.journeyRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { journey: true, journeyVersion: true },
    }),
    // Candidates for a manual test run. The extension-wrapped client scopes this
    // to the tenant and drops soft-deleted rows; open leads only, and capped,
    // because this feeds a <select> and the operator is looking for one they
    // recognise, not browsing the pipeline.
    prisma.lead.findMany({
      where: { status: "open" },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, title: true, name: true },
    }),
  ]);
  const options = { stages, users, templates, tags, segments };
  const leadOptions = testLeads.map((lead) => ({
    id: lead.id,
    label: lead.title || lead.name,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketing journeys & advanced automations"
        description="Versioned multi-step workflows with safe conditions, waits, messaging, CRM actions, segment enrolment and execution history."
      >
        {/* The trace. A journey that enrols nobody is indistinguishable from one
            that matched nobody until you can see whether its trigger ever fired. */}
        <Link href="/journeys/activity" className="btn-secondary">
          <Activity className="size-4" />
          Activity &amp; traces
        </Link>
        <form action={installJourneyTemplates}>
          <button className="btn-secondary">Install recommended drafts</button>
        </form>
      </PageHeader>

      <details className="card" open={journeys.length === 0}>
        <summary className="font-semibold cursor-pointer">+ Create a journey</summary>
        <div className="mt-5"><JourneyBuilder {...options} /></div>
      </details>

      <section className="space-y-3">
        <h2 className="font-semibold">Journey library</h2>
        {journeys.length === 0 ? (
          <EmptyState icon={Workflow} title="No journeys configured" description="Install the recommended drafts for a guided start, or create a journey with your own trigger and actions." />
        ) : journeys.map((journey) => {
          const draft = journey.versions.find((version) => version.state === "draft");
          const published = journey.versions.find((version) => version.version === journey.activeVersion);
          const editable = draft ?? published ?? journey.versions[0];
          // Visible without opening the editor, deliberately. Journeys created
          // before run modes existed were backfilled to `parallel` while new
          // ones default to `single`, so two journeys on this list can do
          // opposite things on a second enrolment and nothing else says which.
          const runMode = JOURNEY_RUN_MODE_COPY[parseRunMode(journey.runMode)];
          return (
            <article key={journey.id} className="card space-y-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-64">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{journey.name}</h3>
                    <StatusPill tone={statusTone(journey.status)}>{journey.status}</StatusPill>
                    <StatusPill>{journey.category}</StatusPill>
                    {/* Parallel is the only mode that lets one person receive
                        two live sequences, so it is the only one badged as a
                        thing to notice rather than a neutral fact. */}
                    <StatusPill tone={runMode.value === "parallel" ? "warning" : "neutral"}>
                      re-enrol: {runMode.value}
                    </StatusPill>
                    {draft && <StatusPill tone="info">draft v{draft.version}</StatusPill>}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{journey.description || "No description"}</p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Trigger: {triggerLabel((published ?? editable)?.trigger ?? "unknown")} · Active version: {journey.activeVersion ?? "none"} · Runs: {journey._count.runs}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Re-enrolled while a run is open? {runMode.description}
                  </p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {draft && <form action={publishJourney.bind(null, journey.id)}><button className="btn-primary btn-sm">Publish v{draft.version}</button></form>}
                  {journey.status === "active" ? (
                    <form action={setJourneyStatus.bind(null, journey.id, "paused")}><button className="btn-secondary btn-sm">Pause</button></form>
                  ) : journey.activeVersion ? (
                    <form action={setJourneyStatus.bind(null, journey.id, "active")}><button className="btn-secondary btn-sm">Resume</button></form>
                  ) : null}
                  {journey.status === "active" && ["lead_idle", "contact_segment", "purchase_anniversary", "win_back"].includes(published?.trigger ?? "") && (
                    <form action={runJourneyNowAction.bind(null, journey.id)}><button className="btn-secondary btn-sm">Enroll now</button></form>
                  )}
                  {/* Offered as soon as there is something published to run.
                      Not gated on `active`: the action refuses a paused journey
                      in words, and reading that refusal is more useful than
                      wondering where the button went. */}
                  {journey.activeVersion && (
                    <JourneyTestRun journeyId={journey.id} journeyName={journey.name} leads={leadOptions} />
                  )}
                  <form action={setJourneyStatus.bind(null, journey.id, "archived")}><button className="text-xs text-red-400 px-2 py-1">Archive</button></form>
                </div>
              </div>

              {editable && (
                <details className="rounded-lg border border-border p-4">
                  <summary className="cursor-pointer text-sm font-medium text-primary">
                    Edit {draft ? `draft v${draft.version}` : "as a new draft"}
                  </summary>
                  <div className="mt-5">
                    <JourneyBuilder
                      {...options}
                      defaults={defaultsFor(journey, editable)}
                      submitAction={saveJourneyDraft.bind(null, journey.id)}
                      submitLabel="Save draft"
                    />
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-4">Recent journey runs</h2>
        {recentRuns.length === 0 ? (
          <EmptyState icon={Activity} title="No journey runs yet" description="Execution history appears here after an active journey enrols a lead or contact." className="py-8" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Journey</th><th>Record</th><th>Version</th><th>Status</th><th>Current step</th><th>Started</th><th>Error</th><th>Actions</th></tr></thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td className="font-medium">{run.journey.name}</td>
                    <td>
                      {run.leadId ? <Link className="text-primary hover:underline" href={`/leads/${run.leadId}`}>Lead</Link>
                        : run.contactId ? <Link className="text-primary hover:underline" href={`/contacts/${run.contactId}`}>Contact</Link>
                        : run.entityType}
                    </td>
                    <td>v{run.journeyVersion.version}</td>
                    <td><StatusPill tone={statusTone(run.status)}>{run.status}</StatusPill></td>
                    <td className="text-xs text-muted-foreground">{run.currentStepId ?? "—"}</td>
                    <td className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</td>
                    <td className="text-xs text-red-300 max-w-64 truncate">{run.lastError ?? "—"}</td>
                    <td>
                      <div className="flex gap-2">
                        {/* The path this particular run took. "Current step" in
                            the column above is one step id, which inside a
                            repeat names a node the run has visited many times. */}
                        <Link className="text-xs text-primary hover:underline" href={`/journeys/activity?run=${run.id}`}>
                          Trace
                        </Link>
                        {["failed", "cancelled"].includes(run.status) && (
                          <form action={retryJourneyRun.bind(null, run.id)}><button className="btn-secondary btn-sm">Retry</button></form>
                        )}
                        {["queued", "waiting"].includes(run.status) && (
                          <form action={cancelJourneyRun.bind(null, run.id)}><button className="text-xs text-red-400">Cancel</button></form>
                        )}
                      </div>
                    </td>
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
