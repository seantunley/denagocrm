import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { DEFAULT_FLOW } from "@/lib/flow";
import { createFlow, setActiveFlow, duplicateFlow, deleteFlow, renameFlow } from "@/app/actions/flow";
import { PageHeader } from "@/components/page-header";

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
      <PageHeader title="Chatbot flows" description={`${flows.length} conversation flow${flows.length === 1 ? "" : "s"} · One active journey runs across connected channels.`}>
        <form action={createFlow}>
          <input type="hidden" name="name" value="New flow" />
          <button className="btn-primary btn-sm"><Plus className="size-4" />New flow</button>
        </form>
      </PageHeader>

      <div className="grid md:grid-cols-2 gap-4">
        {flows.map((f) => (
          <div key={f.id} className="card space-y-3">
            <div className="flex items-center justify-between gap-2">
              <form action={renameFlow.bind(null, f.id)} className="flex-1 min-w-0">
                <input
                  name="name"
                  defaultValue={f.name}
                  className="bg-transparent font-semibold text-foreground w-full outline-none focus:bg-muted rounded px-1 -mx-1"
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
            <p className="text-xs text-muted-foreground">Updated {f.updatedAt.toLocaleDateString("en-ZA")}</p>
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
