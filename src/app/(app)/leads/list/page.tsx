import Link from "next/link";
import { subDays } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { saveView, deleteView } from "@/app/actions/views";
import { contactName, formatDate, formatZAR } from "@/lib/format";

export const metadata = { title: "Lead list — DenagoCRM" };

type Params = {
  status?: string;
  source?: string;
  stageId?: string;
  minValue?: string;
  days?: string;
};

export default async function LeadListPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  await requireUser();
  const p = await searchParams;
  const status = p.status || "";
  const source = p.source || "";
  const stageId = p.stageId || "";
  const minValue = parseInt(p.minValue || "", 10);
  const days = parseInt(p.days || "", 10);

  const [stages, views, leads] = await Promise.all([
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    prisma.savedView.findMany({ where: { page: "leads" }, orderBy: { createdAt: "asc" } }),
    prisma.lead.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(source ? { source } : {}),
        ...(stageId ? { stageId } : {}),
        ...(!isNaN(minValue) && minValue > 0 ? { valueCents: { gte: minValue * 100 } } : {}),
        ...(!isNaN(days) && days > 0 ? { createdAt: { gte: subDays(new Date(), days) } } : {}),
      },
      include: { stage: true, product: true, contact: true, assignedTo: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  const currentQuery = new URLSearchParams(
    Object.fromEntries(Object.entries(p).filter(([, v]) => v)) as Record<string, string>
  ).toString();
  const totalValue = leads.reduce((s, l) => s + l.valueCents, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Lead list</h1>
          <p className="text-sm text-slate-400 mt-1">
            Filter, save the view, come back to it in one click.{" "}
            <Link href="/leads" className="text-orange-400 hover:underline">
              Board view →
            </Link>
          </p>
        </div>
      </div>

      {views.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href="/leads/list"
            className={`badge cursor-pointer ${!currentQuery ? "bg-orange-500/15 text-orange-300" : "bg-slate-800 text-slate-300 hover:text-white"}`}
          >
            All leads
          </Link>
          {views.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1">
              <Link
                href={`/leads/list?${v.query}`}
                className={`badge cursor-pointer ${currentQuery === v.query ? "bg-orange-500/15 text-orange-300" : "bg-slate-800 text-slate-300 hover:text-white"}`}
              >
                {v.name}
              </Link>
              <form action={deleteView.bind(null, v.id)}>
                <button
                  className="text-slate-600 hover:text-red-400 text-xs cursor-pointer"
                  title="Delete view"
                >
                  ✕
                </button>
              </form>
            </span>
          ))}
        </div>
      )}

      <form method="GET" className="card p-4 flex items-end gap-3 flex-wrap">
        <div>
          <label className="label">Status</label>
          <select name="status" className="input w-32" defaultValue={status}>
            <option value="">Any</option>
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
        </div>
        <div>
          <label className="label">Source</label>
          <select name="source" className="input w-36" defaultValue={source}>
            <option value="">Any</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="website">Website</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="referral">Referral</option>
            <option value="manual">Manual</option>
            <option value="walk-in">Walk-in</option>
          </select>
        </div>
        <div>
          <label className="label">Stage</label>
          <select name="stageId" className="input w-36" defaultValue={stageId}>
            <option value="">Any</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Value at least (R)</label>
          <input name="minValue" type="number" className="input w-32" defaultValue={p.minValue ?? ""} />
        </div>
        <div>
          <label className="label">Created in last (days)</label>
          <input name="days" type="number" className="input w-32" defaultValue={p.days ?? ""} />
        </div>
        <button className="btn-primary btn-sm">Filter</button>
        {currentQuery && (
          <Link href="/leads/list" className="btn-secondary btn-sm">
            Clear
          </Link>
        )}
      </form>

      {currentQuery && (
        <form action={saveView} className="flex items-center gap-2">
          <input type="hidden" name="page" value="leads" />
          <input type="hidden" name="query" value={currentQuery} />
          <input
            name="name"
            className="input w-64 text-sm"
            placeholder="Name this view — e.g. Big Facebook leads"
            required
          />
          <button className="btn-secondary btn-sm">💾 Save view</button>
        </form>
      )}

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Stage</th>
              <th>Source</th>
              <th className="text-right">Value</th>
              <th>Created</th>
              <th>Assigned</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-8">
                  Nothing matches these filters.
                </td>
              </tr>
            )}
            {leads.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link href={`/leads/${l.id}`} className="font-medium text-orange-400 hover:underline">
                    {l.name}
                  </Link>
                  <p className="text-xs text-slate-400 truncate max-w-52">{l.title}</p>
                </td>
                <td>
                  {l.status === "open" ? (
                    <span className="badge text-white" style={{ backgroundColor: l.stage.color }}>
                      {l.stage.name}
                    </span>
                  ) : (
                    <span
                      className={`badge ${
                        l.status === "won"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-red-500/15 text-red-300"
                      }`}
                    >
                      {l.status}
                    </span>
                  )}
                </td>
                <td className="text-sm capitalize text-slate-300">{l.source}</td>
                <td className="text-right font-medium">
                  {l.valueCents > 0 ? formatZAR(l.valueCents) : "—"}
                </td>
                <td className="text-sm text-slate-400">{formatDate(l.createdAt)}</td>
                <td className="text-sm text-slate-400">{l.assignedTo?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {leads.length > 0 && (
          <p className="px-4 py-2.5 text-xs text-slate-400 border-t border-slate-800">
            {leads.length} lead{leads.length !== 1 ? "s" : ""} · total value{" "}
            <span className="font-semibold text-slate-200">{formatZAR(totalValue)}</span>
          </p>
        )}
      </div>
    </div>
  );
}
