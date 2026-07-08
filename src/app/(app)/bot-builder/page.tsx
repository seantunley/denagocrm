import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { DEFAULT_FLOW } from "@/lib/flow";
import { createFlow, setActiveFlow, duplicateFlow, deleteFlow, renameFlow } from "@/app/actions/flow";

export default async function BotBuilderPage() {
  await requireOwner();

  // One-time seed / migrate the previous single flow into the library.
  if ((await prisma.botFlow.count()) === 0) {
    const legacy = await getSetting("BOT_FLOW");
    let definition = JSON.stringify(DEFAULT_FLOW);
    let name = "Default flow";
    if (legacy) {
      try {
        const f = JSON.parse(legacy);
        if (f?.start && f?.nodes) {
          definition = legacy;
          name = "My flow";
        }
      } catch {
        /* keep default */
      }
    }
    await prisma.botFlow.create({ data: { name, definition, active: true } });
    if (legacy) await putSetting("BOT_FLOW", "");
  }

  const flows = await prisma.botFlow.findMany({ orderBy: [{ active: "desc" }, { updatedAt: "desc" }] });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Chatbot flows</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Build as many conversation flows as you like. The one marked <b className="text-emerald-400">Live</b> runs
            on WhatsApp (turn the bot on in Settings → WhatsApp Bot).
          </p>
        </div>
        <form action={createFlow}>
          <input type="hidden" name="name" value="New flow" />
          <button className="btn-primary">+ New flow</button>
        </form>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {flows.map((f) => (
          <div key={f.id} className="card space-y-3">
            <div className="flex items-center justify-between gap-2">
              <form action={renameFlow.bind(null, f.id)} className="flex-1 min-w-0">
                <input
                  name="name"
                  defaultValue={f.name}
                  className="bg-transparent font-semibold text-slate-100 w-full outline-none focus:bg-slate-800 rounded px-1 -mx-1"
                />
              </form>
              {f.active ? (
                <span className="badge bg-emerald-500/15 text-emerald-300 shrink-0">Live</span>
              ) : (
                <form action={setActiveFlow.bind(null, f.id)}>
                  <button className="btn-secondary btn-sm">Set live</button>
                </form>
              )}
            </div>
            <p className="text-xs text-slate-500">Updated {f.updatedAt.toLocaleDateString("en-ZA")}</p>
            <div className="flex gap-2 flex-wrap">
              <Link href={`/bot-builder/${f.id}`} className="btn-primary btn-sm">🎨 Edit</Link>
              <form action={duplicateFlow.bind(null, f.id)}>
                <button className="btn-secondary btn-sm">Duplicate</button>
              </form>
              {!f.active && (
                <form action={deleteFlow.bind(null, f.id)}>
                  <button className="btn-secondary btn-sm text-red-400">Delete</button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
