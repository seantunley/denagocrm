import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { getJourneyRunSummary, listJourneys } from "@/lib/marketingJourneys";
import { toggleMarketingJourney } from "@/app/actions/marketingJourneys";

export const dynamic = "force-dynamic";

type RecentEnrollment = {
  id: string;
  journeyName: string;
  leadId: string | null;
  contactId: string | null;
  status: string;
  currentStep: number;
  startedAt: Date;
  completedAt: Date | null;
  stoppedReason: string | null;
};

export default async function MarketingJourneysPage() {
  await requireUser();
  const [journeys, summary, recent] = await Promise.all([
    listJourneys(),
    getJourneyRunSummary(),
    basePrisma.$queryRaw<RecentEnrollment[]>`
      SELECT e."id", j."name" AS "journeyName", e."leadId", e."contactId", e."status",
        e."currentStep", e."startedAt", e."completedAt", e."stoppedReason"
      FROM "MarketingJourneyEnrollment" e
      JOIN "MarketingJourney" j ON j."id" = e."journeyId"
      ORDER BY e."createdAt" DESC
      LIMIT 30
    `,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href="/automations" className="hover:text-orange-400">Automations</Link>
            <span>/</span><span>Journeys</span>
          </div>
          <h1 className="text-2xl font-bold">Marketing journeys</h1>
          <p className="text-sm text-slate-400 mt-1">
            Versioned multi-step campaigns and CRM workflows with waits, branching, consent and reply stopping.
          </p>
        </div>
        <Link href="/automations/journeys/new" className="btn-primary">+ New journey</Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ["Active", summary.active ?? 0],
          ["Waiting", summary.waiting ?? 0],
          ["Completed", summary.completed ?? 0],
          ["Stopped", summary.stopped ?? 0],
          ["Failed", summary.failed ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="card">
            <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
        ))}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Journey</th><th>Trigger</th><th>Status</th><th>Controls</th></tr></thead>
          <tbody>
            {journeys.length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-400 py-8">No journeys yet.</td></tr>
            )}
            {journeys.map((journey) => (
              <tr key={journey.id}>
                <td>
                  <Link href={`/automations/journeys/${journey.id}`} className="font-medium text-orange-400 hover:underline">
                    {journey.name}
                  </Link>
                  {journey.description && <p className="text-xs text-slate-500 mt-0.5 max-w-xl">{journey.description}</p>}
                </td>
                <td className="text-xs font-mono">{journey.trigger}</td>
                <td>
                  {journey.active ? <span className="badge bg-emerald-950 text-emerald-300">Live</span> :
                    journey.publishedVersionId ? <span className="badge bg-slate-800 text-slate-300">Paused</span> :
                    <span className="badge bg-amber-950 text-amber-300">Draft</span>}
                </td>
                <td>
                  {journey.publishedVersionId && (
                    <form action={toggleMarketingJourney.bind(null, journey.id)}>
                      <button className="btn-secondary btn-sm">{journey.active ? "Pause" : "Resume"}</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Recent enrolments</h2>
        {recent.length === 0 ? <p className="text-sm text-slate-400">No journey enrolments yet.</p> : (
          <ul className="divide-y divide-slate-800">
            {recent.map((run) => (
              <li key={run.id} className="py-2 flex items-center gap-3 text-sm">
                <span className={run.status === "completed" ? "text-emerald-400" : run.status === "stopped" ? "text-amber-400" : "text-sky-400"}>●</span>
                <div className="flex-1 min-w-0">
                  <p><span className="font-medium">{run.journeyName}</span> · {run.status} · step {run.currentStep + 1}</p>
                  <p className="text-xs text-slate-500 truncate">{run.stoppedReason ?? "In progress"} · {formatDateTime(run.startedAt)}</p>
                </div>
                {run.leadId && <Link href={`/leads/${run.leadId}`} className="text-xs text-orange-400">Lead</Link>}
                {run.contactId && <Link href={`/contacts/${run.contactId}`} className="text-xs text-orange-400">Contact</Link>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
