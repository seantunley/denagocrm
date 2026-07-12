import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { getJourney, type JourneyDefinition } from "@/lib/marketingJourneys";
import MarketingJourneyForm from "@/components/MarketingJourneyForm";
import {
  archiveMarketingJourney,
  publishMarketingJourney,
  saveMarketingJourney,
  toggleMarketingJourney,
} from "@/app/actions/marketingJourneys";
import ConfirmDelete from "@/components/ConfirmDelete";

export const dynamic = "force-dynamic";

type StepRun = {
  id: string;
  status: string;
  stepIndex: number;
  stepType: string;
  error: string | null;
  startedAt: Date;
  journeyStatus: string;
  leadId: string | null;
  contactId: string | null;
};

export default async function JourneyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const data = await getJourney(id);
  if (!data) notFound();
  const { journey, versions } = data;
  const draft = versions.find((version) => version.id === journey.currentDraftVersionId);
  const published = versions.find((version) => version.id === journey.publishedVersionId);
  const editableDefinition = (draft?.definition ?? published?.definition ?? { steps: [{ type: "end" }] }) as JourneyDefinition;
  const recentRuns = await basePrisma.$queryRaw<StepRun[]>`
    SELECT sr."id", sr."status", sr."stepIndex", sr."stepType", sr."error", sr."startedAt",
      e."status" AS "journeyStatus", e."leadId", e."contactId"
    FROM "MarketingJourneyStepRun" sr
    JOIN "MarketingJourneyEnrollment" e ON e."id" = sr."enrollmentId"
    WHERE e."journeyId" = ${id}
    ORDER BY sr."startedAt" DESC
    LIMIT 40
  `;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href="/automations/journeys" className="hover:text-orange-400">Marketing journeys</Link>
            <span>/</span><span>{journey.name}</span>
          </div>
          <h1 className="text-2xl font-bold">{journey.name}</h1>
          <p className="text-sm text-slate-400 mt-1">
            {journey.active ? "Live" : journey.publishedVersionId ? "Paused" : "Draft only"} · trigger <code>{journey.trigger}</code>
          </p>
        </div>
        <div className="flex gap-2">
          {journey.publishedVersionId && (
            <form action={toggleMarketingJourney.bind(null, journey.id)}>
              <button className="btn-secondary">{journey.active ? "Pause" : "Resume"}</button>
            </form>
          )}
          {journey.currentDraftVersionId && (
            <form action={publishMarketingJourney.bind(null, journey.id)}>
              <button className="btn-primary">Publish draft</button>
            </form>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <div className="card"><p className="text-xs text-slate-400">Published version</p><p className="text-xl font-bold mt-1">{published ? `v${published.version}` : "—"}</p></div>
        <div className="card"><p className="text-xs text-slate-400">Draft version</p><p className="text-xl font-bold mt-1">{draft ? `v${draft.version}` : "New draft on save"}</p></div>
        <div className="card"><p className="text-xs text-slate-400">Frequency cap</p><p className="text-xl font-bold mt-1">{journey.frequencyCapHours}h</p></div>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Edit draft</h2>
        <MarketingJourneyForm
          action={saveMarketingJourney.bind(null, journey.id)}
          defaults={{
            name: journey.name,
            description: journey.description,
            trigger: journey.trigger,
            stopOnReply: journey.stopOnReply,
            respectMarketingConsent: journey.respectMarketingConsent,
            frequencyCapHours: journey.frequencyCapHours,
            definition: editableDefinition,
          }}
        />
      </div>

      <div className="card p-0 overflow-x-auto">
        <div className="p-4 pb-0"><h2 className="font-semibold">Version history</h2></div>
        <table className="table-base">
          <thead><tr><th>Version</th><th>Status</th><th>Created</th><th>Published</th><th>Steps</th></tr></thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.id}>
                <td>v{version.version}</td>
                <td><span className="badge bg-slate-800 text-slate-300">{version.status}</span></td>
                <td>{formatDateTime(version.createdAt)}</td>
                <td>{version.publishedAt ? formatDateTime(version.publishedAt) : "—"}</td>
                <td>{version.definition.steps.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Recent step runs</h2>
        {recentRuns.length === 0 ? <p className="text-sm text-slate-400">No runs yet.</p> : (
          <ul className="divide-y divide-slate-800">
            {recentRuns.map((run) => (
              <li key={run.id} className="py-2 flex gap-3 text-sm">
                <span className={run.status === "completed" ? "text-emerald-400" : "text-red-400"}>{run.status === "completed" ? "✓" : "✕"}</span>
                <div className="flex-1">
                  <p>Step {run.stepIndex + 1}: <code>{run.stepType}</code> · {run.journeyStatus}</p>
                  <p className="text-xs text-slate-500">{run.error ?? formatDateTime(run.startedAt)}</p>
                </div>
                {run.leadId && <Link href={`/leads/${run.leadId}`} className="text-xs text-orange-400">Lead</Link>}
                {run.contactId && <Link href={`/contacts/${run.contactId}`} className="text-xs text-orange-400">Contact</Link>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card border-red-950">
        <h2 className="font-semibold text-red-300 mb-2">Archive journey</h2>
        <p className="text-sm text-slate-400 mb-3">Archiving pauses the journey and stops active enrolments. Historical versions and runs remain available in the database.</p>
        <ConfirmDelete
          action={archiveMarketingJourney.bind(null, journey.id)}
          title={`Archive “${journey.name}”?`}
          description="Active and waiting enrolments will be stopped. This journey will disappear from the active list."
          trigger="Archive journey"
          triggerClass="btn-secondary text-red-300"
        />
      </div>
    </div>
  );
}
