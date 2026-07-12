import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
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
    ? group.conditions.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
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

function triggerLabel(trigger: string) {
  return trigger.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusClass(status: string) {
  if (status === "completed") return "bg-emerald-950 text-emerald-300";
  if (status === "failed") return "bg-red-950 text-red-300";
  if (status === "waiting") return "bg-blue-950 text-blue-300";
  if (status === "cancelled") return "bg-slate-800 text-slate-400";
  return "bg-slate-800 text-slate-300";
}

export default async function JourneysPage() {
  await requireOwner();
  const [journeys, stages, users, templates, tags, segments, recentRuns, lifecycleSettings] = await Promise.all([
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
    prisma.appSetting.findMany({
      where: { key: { in: ["LIFECYCLE_ANNIVERSARY_ENABLED", "LIFECYCLE_WINBACK_ENABLED"] } },
    }),
  ]);
  const options = { stages, users, templates, tags, segments };
  const legacyLifecycleEnabled = lifecycleSettings.some((setting) => setting.value === "true");

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href="/automations" className="hover:text-orange-400">Automations</Link>
            <span>/</span><span>Journeys</span>
          </div>
          <h1 className="text-2xl font-bold">Marketing journeys & advanced automations</h1>
          <p className="text-sm text-slate-400 mt-1 max-w-3xl">
            Versioned multi-step workflows with safe conditions, waits, email, SMS, CRM actions,
            segment enrollment and detailed execution history.
          </p>
        </div>
        <form action={installJourneyTemplates}>
          <button className="btn-secondary">Install recommended drafts</button>
        </form>
      </div>

      {legacyLifecycleEnabled && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-4 text-sm">
          <p className="font-medium text-amber-300">Legacy lifecycle emails are still enabled</p>
          <p className="text-slate-400 mt-1">
            Disable the old anniversary and win-back toggles in Settings before activating equivalent
            advanced journeys, otherwise customers could receive both versions.
          </p>
        </div>
      )}

      <details className="card" open={journeys.length === 0}>
        <summary className="font-semibold cursor-pointer">+ Create a journey</summary>
        <div className="mt-5"><JourneyBuilder {...options} /></div>
      </details>

      <section className="space-y-3">
        <h2 className="font-semibold">Journey library</h2>
        {journeys.length === 0 ? (
          <div className="card text-sm text-slate-400">
            No journeys yet. Install the recommended drafts or create one above.
          </div>
        ) : journeys.map((journey) => {
          const draft = journey.versions.find((version) => version.state === "draft");
          const published = journey.versions.find((version) => version.version === journey.activeVersion);
          const editable = draft ?? published ?? journey.versions[0];
          return (
            <article key={journey.id} className="card space-y-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-64">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{journey.name}</h3>
                    <span className={`badge ${journey.status === "active" ? "bg-emerald-950 text-emerald-300" : journey.status === "paused" ? "bg-amber-950 text-amber-300" : "bg-slate-800 text-slate-300"}`}>
                      {journey.status}
                    </span>
                    <span className="badge bg-slate-800 text-slate-300">{journey.category}</span>
                    {draft && <span className="badge bg-blue-950 text-blue-300">draft v{draft.version}</span>}
                  </div>
                  <p className="text-sm text-slate-400 mt-1">{journey.description || "No description"}</p>
                  <p className="text-xs text-slate-500 mt-2">
                    Trigger: {triggerLabel((published ?? editable)?.trigger ?? "unknown")} · Active version: {journey.activeVersion ?? "none"} · Runs: {journey._count.runs}
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
                  <form action={setJourneyStatus.bind(null, journey.id, "archived")}><button className="text-xs text-red-400 px-2 py-1">Archive</button></form>
                </div>
              </div>

              {editable && (
                <details className="rounded-lg border border-slate-800 p-4">
                  <summary className="cursor-pointer text-sm font-medium text-orange-400">
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
          <p className="text-sm text-slate-400">Runs appear here after an active journey enrolls a lead or contact.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Journey</th><th>Record</th><th>Version</th><th>Status</th><th>Current step</th><th>Started</th><th>Error</th><th>Actions</th></tr></thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td className="font-medium">{run.journey.name}</td>
                    <td>
                      {run.leadId ? <Link className="text-orange-400 hover:underline" href={`/leads/${run.leadId}`}>Lead</Link>
                        : run.contactId ? <Link className="text-orange-400 hover:underline" href={`/contacts/${run.contactId}`}>Contact</Link>
                        : run.entityType}
                    </td>
                    <td>v{run.journeyVersion.version}</td>
                    <td><span className={`badge ${statusClass(run.status)}`}>{run.status}</span></td>
                    <td className="text-xs text-slate-400">{run.currentStepId ?? "—"}</td>
                    <td className="text-xs text-slate-400">{formatDateTime(run.createdAt)}</td>
                    <td className="text-xs text-red-300 max-w-64 truncate">{run.lastError ?? "—"}</td>
                    <td>
                      <div className="flex gap-2">
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
