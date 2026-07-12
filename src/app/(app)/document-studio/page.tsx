import Link from "next/link";
import { FileText, PenLine, Plus, Rocket, ScrollText, Star } from "lucide-react";
import { prisma } from "@/lib/db";
import { DOC_DEFS, DOC_GROUPS, type DocKey } from "@/lib/docTemplates";
import { ensureSeeded, listTemplates } from "@/lib/docTemplateStore";
import { formatDate } from "@/lib/format";
import { createDocTemplate } from "@/app/actions/documents";
import { createReusableBlock, createStudioTemplate } from "@/app/actions/studio";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function DocumentStudioPage() {
  await ensureSeeded();
  const keys = Object.keys(DOC_DEFS) as DocKey[];
  const [studioTemplates, clauses, instances, ...typedLists] = await Promise.all([
    prisma.customDocTemplate.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: { orderBy: { version: "desc" }, take: 1, select: { version: true } },
        _count: { select: { instances: true } },
      },
    }),
    prisma.reusableBlock.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    prisma.docInstance.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 12 }),
    ...keys.map((key) => listTemplates(key)),
  ]);
  const typedByKey = Object.fromEntries(keys.map((key, index) => [key, typedLists[index]])) as Record<
    DocKey,
    Awaited<ReturnType<typeof listTemplates>>
  >;

  const input =
    "h-9 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

  return (
    <div className="space-y-7">
      <PageHeader
        title="Document Studio"
        description="Two clearly separated tools: operational templates control the CRM's built-in PDFs; free-form templates create standalone custom documents."
      >
        <Link href="/documents" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <FileText className="size-4" />
          Open document repository
        </Link>
      </PageHeader>

      <section className="rounded-2xl border border-orange-500/25 bg-orange-500/[0.06] p-5">
        <h2 className="text-base font-semibold text-foreground">1. Operational templates</h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
          These are the templates used automatically when the CRM prints a quote, invoice, sales agreement,
          indemnity, delivery note, job card, service report or warranty claim. Edit these when you want to
          change those real operational documents.
        </p>
      </section>

      <div className="space-y-6">
        {DOC_GROUPS.map((group) => (
          <section key={group.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
              <p className="text-xs text-muted-foreground">Templates below feed directly into the matching CRM print/PDF route.</p>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              {group.keys.map((key) => {
                const definition = DOC_DEFS[key];
                const templates = typedByKey[key];
                return (
                  <div key={key} className="rounded-xl border border-border/70 bg-background/30 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-foreground">{definition.label}</p>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{definition.description}</p>
                      </div>
                      <span className="rounded bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Built-in
                      </span>
                    </div>
                    <ul className="mt-3 divide-y divide-border/50">
                      {templates.map((template) => (
                        <li key={template.id} className="flex items-center gap-2 py-2">
                          <div className="min-w-0 flex-1">
                            <Link href={`/settings/documents/t/${template.id}`} className="truncate text-[13px] font-medium text-foreground hover:text-primary">
                              {template.name}
                            </Link>
                            {template.isDefault && (
                              <span className="ml-2 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                <Star className="size-3" />Default
                              </span>
                            )}
                          </div>
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/settings/documents/t/${template.id}`}>
                              <PenLine className="size-3.5" />Edit
                            </Link>
                          </Button>
                        </li>
                      ))}
                    </ul>
                    <form action={createDocTemplate} className="mt-3 flex flex-wrap gap-2">
                      <input type="hidden" name="docType" value={key} />
                      <input name="name" required placeholder={`New ${definition.label.toLowerCase()} template…`} className={`${input} min-w-48 flex-1`} />
                      <select name="baseId" defaultValue="" className={input}>
                        <option value="">Start from standard</option>
                        {templates.map((template) => <option key={template.id} value={template.id}>Copy {template.name}</option>)}
                      </select>
                      <Button size="sm" type="submit"><Plus className="size-3.5" />Create</Button>
                    </form>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <section className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.05] p-5">
        <h2 className="text-base font-semibold text-foreground">2. Free-form Studio</h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
          This editor creates standalone documents from blocks, clauses and merge fields. It does not currently
          replace the operational quote or indemnity renderer above. Use it for custom proposals, letters,
          handover packs and documents that do not have a dedicated CRM screen.
        </p>
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Rocket className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Free-form templates</h3>
          </div>
          <ul className="divide-y divide-border/50">
            {studioTemplates.length === 0 && <li className="py-3 text-xs text-muted-foreground">No free-form templates yet.</li>}
            {studioTemplates.map((template) => (
              <li key={template.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/settings/documents/studio/t/${template.id}`} className="truncate text-[13px] font-medium hover:text-primary">
                    {template.name}
                  </Link>
                  <p className="text-[11px] text-muted-foreground">
                    {template.versions[0] ? `v${template.versions[0].version} published` : "Draft only"} · {template._count.instances} document{template._count.instances === 1 ? "" : "s"}
                  </p>
                </div>
                <Button asChild variant="outline" size="sm"><Link href={`/settings/documents/studio/t/${template.id}`}><PenLine className="size-3.5" />Edit</Link></Button>
              </li>
            ))}
          </ul>
          <form action={createStudioTemplate} className="mt-3 flex gap-2">
            <input name="name" required placeholder="New free-form template…" className={`${input} flex-1`} />
            <Button size="sm" type="submit"><Plus className="size-3.5" />Create</Button>
          </form>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <ScrollText className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Reusable clauses</h3>
          </div>
          <p className="mb-2 text-xs leading-5 text-muted-foreground">Reusable clauses work only inside the free-form Studio. They are copied into a document when inserted.</p>
          <ul className="divide-y divide-border/50">
            {clauses.length === 0 && <li className="py-3 text-xs text-muted-foreground">No reusable clauses yet.</li>}
            {clauses.map((clause) => (
              <li key={clause.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/settings/documents/studio/c/${clause.id}`} className="truncate text-[13px] font-medium hover:text-primary">{clause.name}</Link>
                  <p className="text-[11px] text-muted-foreground">Edited {formatDate(clause.updatedAt)}</p>
                </div>
                <Button asChild variant="outline" size="sm"><Link href={`/settings/documents/studio/c/${clause.id}`}><PenLine className="size-3.5" />Edit</Link></Button>
              </li>
            ))}
          </ul>
          <form action={createReusableBlock} className="mt-3 flex gap-2">
            <input name="name" required placeholder="New reusable clause…" className={`${input} flex-1`} />
            <Button size="sm" type="submit"><Plus className="size-3.5" />Create</Button>
          </form>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold">Recent free-form documents</h3>
        <ul className="divide-y divide-border/50">
          {instances.length === 0 && <li className="py-3 text-xs text-muted-foreground">No free-form documents have been generated yet.</li>}
          {instances.map((instance) => (
            <li key={instance.id} className="flex items-center gap-3 py-2">
              <FileText className="size-4 text-muted-foreground" />
              <Link href={`/settings/documents/studio/d/${instance.id}`} className="min-w-0 flex-1 truncate text-[13px] font-medium hover:text-primary">{instance.title}</Link>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">{instance.status}</span>
              <span className="text-[11px] text-muted-foreground">{formatDate(instance.updatedAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
