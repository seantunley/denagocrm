import Link from "next/link";
import {
  ArrowLeft,
  Upload,
  Plus,
  Star,
  Copy,
  Trash2,
  PenLine,
  FileText,
  Wrench,
  Truck,
  ShieldCheck,
  Car,
  ScrollText,
  Receipt,
  ClipboardCheck,
} from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { DOC_DEFS, DOC_GROUPS, type DocKey } from "@/lib/docTemplates";
import { ensureSeeded, listTemplates } from "@/lib/docTemplateStore";
import {
  uploadRepoDocument,
  createDocTemplate,
  setDefaultDocTemplate,
  duplicateDocTemplate,
  deleteDocTemplate,
} from "@/app/actions/documents";
import {
  createStudioTemplate,
  createReusableBlock,
  createDocInstance,
} from "@/app/actions/studio";
import RepoRow, { type RepoDoc, type MoveTargets } from "@/components/RepoRow";
import Tabs from "@/components/Tabs";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const TYPE_ICONS: Record<DocKey, React.ComponentType<{ className?: string }>> = {
  quote: FileText,
  invoice: Receipt,
  agreement: ScrollText,
  indemnity: Car,
  delivery: Truck,
  jobcard: Wrench,
  "service-report": ClipboardCheck,
  "warranty-claim": ShieldCheck,
};

export default async function DocumentsHubPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string; kind?: string; versions?: string; tab?: string }>;
}) {
  await requireOwner();
  await ensureSeeded();
  const { q, tag, kind, versions, tab } = await searchParams;

  const where = {
    ...(versions === "all" ? {} : { replacedById: null }),
    ...(q ? { fileName: { contains: q, mode: "insensitive" as const } } : {}),
    ...(tag ? { tag } : {}),
    ...(kind === "unfiled"
      ? { contactId: null, vehicleId: null, quoteId: null, jobCardId: null }
      : kind === "contact"
        ? { contactId: { not: null } }
        : kind === "vehicle"
          ? { vehicleId: { not: null } }
          : kind === "quote"
            ? { quoteId: { not: null } }
            : {}),
  };

  const [docs, tags, contacts, vehicles, quotes, ...templateLists] = await Promise.all([
    prisma.document.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        contact: true,
        vehicle: { include: { contact: true } },
        jobCard: true,
        uploadedBy: { select: { name: true } },
      },
    }),
    prisma.document.groupBy({ by: ["tag"], where: { tag: { not: null } } }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 300 }),
    prisma.vehicle.findMany({ include: { contact: true }, orderBy: { model: "asc" }, take: 300 }),
    prisma.quote.findMany({
      where: { supersededAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { contact: true },
    }),
    ...(Object.keys(DOC_DEFS) as DocKey[]).map((k) => listTemplates(k)),
  ]);

  // Document Studio data (free-form BlockNote documents)
  const [studioTemplates, studioDocs, studioClauses, openLeads] = await Promise.all([
    prisma.customDocTemplate.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        versions: { orderBy: { version: "desc" }, take: 1, select: { version: true } },
        _count: { select: { instances: true } },
      },
    }),
    prisma.docInstance.findMany({ orderBy: { updatedAt: "desc" }, take: 25 }),
    prisma.reusableBlock.findMany({ orderBy: { name: "asc" } }),
    prisma.lead.findMany({
      where: { status: "open" },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, name: true, title: true },
    }),
  ]);
  const templatesByType = Object.fromEntries(
    (Object.keys(DOC_DEFS) as DocKey[]).map((k, i) => [k, templateLists[i]])
  );

  const docQuoteIds = [...new Set(docs.map((d) => d.quoteId).filter((x): x is string => !!x))];
  const docQuotes = docQuoteIds.length
    ? await prisma.quote.findMany({ where: { id: { in: docQuoteIds } }, select: { id: true, number: true } })
    : [];
  const quoteNumber = new Map(docQuotes.map((qt) => [qt.id, qt.number]));

  const targets: MoveTargets = {
    contacts: contacts.map((c) => ({ id: c.id, label: contactName(c) })),
    vehicles: vehicles.map((v) => ({ id: v.id, label: `${v.model} — ${contactName(v.contact)}` })),
    quotes: quotes.map((qt) => ({
      id: qt.id,
      label: `Q-${qt.number}${qt.contact ? ` — ${contactName(qt.contact)}` : ""}`,
    })),
  };

  const rows: RepoDoc[] = docs.map((d) => ({
    id: d.id,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeKB: Math.max(1, Math.round(d.sizeBytes / 1024)),
    tag: d.tag,
    createdAt: formatDate(d.createdAt),
    superseded: d.replacedById !== null,
    uploadedBy: d.uploadedBy.name,
    filedOn: d.contact
      ? `Customer · ${contactName(d.contact)}`
      : d.vehicle
        ? `Vehicle · ${d.vehicle.model} (${contactName(d.vehicle.contact)})`
        : d.quoteId
          ? `Quote · Q-${quoteNumber.get(d.quoteId) ?? "?"}`
          : d.jobCard
            ? `Job card · #${d.jobCard.number}`
            : null,
  }));

  const input =
    "h-9 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

  const contactLabel = new Map(targets.contacts.map((c) => [c.id, c.label]));

  const studioTab = (
    <div className="space-y-6">
      {/* Create a document — the main event */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-1 text-sm font-semibold text-foreground">New document</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Pick a template (or start blank) and link the customer — merge fields fill in
          automatically and are frozen into the document.
        </p>
        <form action={createDocInstance} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <input name="title" required placeholder="Document title…" className={`${input} xl:col-span-2`} />
          <select name="templateId" className={input} defaultValue="">
            <option value="">Blank document</option>
            {studioTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.versions[0] ? ` (v${t.versions[0].version})` : " (draft)"}
              </option>
            ))}
          </select>
          <select name="contactId" className={input} defaultValue="">
            <option value="">Customer (optional)…</option>
            {targets.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <select name="quoteId" className={input} defaultValue="">
            <option value="">Quote (optional)…</option>
            {targets.quotes.map((qt) => (
              <option key={qt.id} value={qt.id}>
                {qt.label}
              </option>
            ))}
          </select>
          <select name="leadId" className={`${input} sm:col-span-1`} defaultValue="">
            <option value="">Deal (optional)…</option>
            {openLeads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title || l.name}
              </option>
            ))}
          </select>
          <Button type="submit" className="sm:col-span-1">
            <Plus className="size-4" />
            Create document
          </Button>
        </form>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        {/* Templates */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="mb-2 text-sm font-semibold text-foreground">Studio templates</p>
          <ul className="mb-3 divide-y divide-border/50">
            {studioTemplates.length === 0 && (
              <li className="py-2 text-xs text-muted-foreground/70">
                No templates yet — create one below and design it in the editor.
              </li>
            )}
            {studioTemplates.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2">
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  <Link href={`/settings/documents/studio/t/${t.id}`} className="hover:text-primary">
                    {t.name}
                  </Link>
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    {t.versions[0] ? `v${t.versions[0].version} published` : "draft only"} ·{" "}
                    {t._count.instances} doc{t._count.instances === 1 ? "" : "s"}
                  </span>
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/settings/documents/studio/t/${t.id}`}>
                    <PenLine className="size-3.5" />
                    Edit
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          <form action={createStudioTemplate} className="flex gap-2">
            <input name="name" required placeholder="New template name…" className={`${input} flex-1`} />
            <Button size="sm" type="submit">
              <Plus className="size-3.5" />
              Create
            </Button>
          </form>
        </div>

        {/* Reusable clauses */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="mb-2 text-sm font-semibold text-foreground">Reusable clauses</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Payment terms, warranty text, indemnities — write once, insert into any document.
          </p>
          <ul className="mb-3 divide-y divide-border/50">
            {studioClauses.length === 0 && (
              <li className="py-2 text-xs text-muted-foreground/70">No clauses yet.</li>
            )}
            {studioClauses.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  <Link href={`/settings/documents/studio/c/${c.id}`} className="hover:text-primary">
                    {c.name}
                  </Link>
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    edited {formatDate(c.updatedAt)}
                  </span>
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/settings/documents/studio/c/${c.id}`}>
                    <PenLine className="size-3.5" />
                    Edit
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          <form action={createReusableBlock} className="flex gap-2">
            <input name="name" required placeholder="New clause name…" className={`${input} flex-1`} />
            <Button size="sm" type="submit">
              <Plus className="size-3.5" />
              Create
            </Button>
          </form>
        </div>
      </div>

      {/* Recent documents */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-foreground">Documents</p>
        <ul className="divide-y divide-border/50">
          {studioDocs.length === 0 && (
            <li className="py-2 text-xs text-muted-foreground/70">
              Nothing created yet — use “New document” above.
            </li>
          )}
          {studioDocs.map((d) => (
            <li key={d.id} className="flex items-center gap-2 py-2">
              <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                <Link href={`/settings/documents/studio/d/${d.id}`} className="hover:text-primary">
                  {d.title}
                </Link>
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  {d.contactId ? `${contactLabel.get(d.contactId) ?? "customer"} · ` : ""}
                  {formatDate(d.updatedAt)}
                </span>
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  d.status === "final"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {d.status}
              </span>
              {d.pdfDocId && (
                <a
                  href={`/api/files/${d.pdfDocId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  PDF
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );

  const templatesTab = (
    <div className="space-y-8">
      {DOC_GROUPS.map((group) => (
        <section key={group.name} className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.name} documents
          </h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {group.keys.map((key) => {
              const def = DOC_DEFS[key];
              const Icon = TYPE_ICONS[key];
              const list = templatesByType[key] ?? [];
              return (
                <div key={key} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div className="mb-3 flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-4.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{def.label}</p>
                      <p className="text-xs text-muted-foreground">{def.description}</p>
                    </div>
                  </div>

                  <ul className="mb-3 divide-y divide-border/50">
                    {list.map((t) => (
                      <li key={t.id} className="flex items-center gap-2 py-2">
                        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                          {t.name}
                          {t.isDefault && (
                            <span className="ml-2 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                              <Star className="size-2.5" />
                              Default
                            </span>
                          )}
                          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                            edited {formatDate(t.updatedAt)}
                          </span>
                        </p>
                        <Button asChild variant="outline" size="sm" title="Edit this template">
                          <Link href={`/settings/documents/t/${t.id}`}>
                            <PenLine className="size-3.5" />
                            Edit
                          </Link>
                        </Button>
                        {!t.isDefault && (
                          <form action={setDefaultDocTemplate.bind(null, t.id)}>
                            <Button variant="ghost" size="sm" title="Use this template for new documents">
                              <Star className="size-3.5" />
                            </Button>
                          </form>
                        )}
                        <form action={duplicateDocTemplate.bind(null, t.id)}>
                          <Button variant="ghost" size="sm" title="Duplicate">
                            <Copy className="size-3.5" />
                          </Button>
                        </form>
                        {!t.isDefault && (
                          <form action={deleteDocTemplate.bind(null, t.id)}>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-400 hover:text-red-300"
                              title="Delete"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>

                  <form action={createDocTemplate} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="docType" value={key} />
                    <input
                      name="name"
                      required
                      placeholder={`New ${def.label.toLowerCase()} template…`}
                      className={`${input} flex-1 min-w-36`}
                    />
                    <select name="baseId" className={`${input} w-36`} defaultValue="">
                      <option value="">From defaults</option>
                      {list.map((t) => (
                        <option key={t.id} value={t.id}>
                          Copy “{t.name}”
                        </option>
                      ))}
                    </select>
                    <Button size="sm" type="submit">
                      <Plus className="size-3.5" />
                      Create
                    </Button>
                  </form>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );

  const repositoryTab = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex flex-wrap items-center gap-2" action="/settings/documents">
          <input name="q" defaultValue={q ?? ""} placeholder="Search file names…" className={input} />
          <select name="tag" defaultValue={tag ?? ""} className={input}>
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t.tag} value={t.tag!}>
                {t.tag}
              </option>
            ))}
          </select>
          <select name="kind" defaultValue={kind ?? ""} className={input}>
            <option value="">Filed anywhere</option>
            <option value="contact">On customers</option>
            <option value="vehicle">On vehicles</option>
            <option value="quote">On quotes</option>
            <option value="unfiled">Unfiled</option>
          </select>
          <select name="versions" defaultValue={versions ?? ""} className={input}>
            <option value="">Current versions</option>
            <option value="all">Include history</option>
          </select>
          <Button size="sm" variant="outline" type="submit">
            Filter
          </Button>
        </form>
        <form action={uploadRepoDocument} className="ml-auto flex items-center gap-2">
          <input type="file" name="file" required className="block max-w-52 text-xs text-muted-foreground" />
          <Button size="sm" type="submit">
            <Upload className="size-3.5" />
            Upload
          </Button>
        </form>
      </div>

      <div className="rounded-xl border border-border bg-card px-4 py-1 shadow-sm">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((d) => (
              <RepoRow key={d.id} doc={d} targets={targets} />
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Every signed quote, invoice, proof of payment, delivery note, photo and upload lives here.
        Showing latest {rows.length} — filter to narrow down.
      </p>
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/settings"
          className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Settings
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Eight document types across your sales, fulfilment and workshop flows — multiple
          templates per type, one default each — plus the repository of every stored file.
        </p>
      </div>

      <div className="rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-3">
        <p className="text-sm">
          <span className="mr-2">🧪</span>
          <span className="font-semibold text-foreground">New editor prototypes</span>
          <span className="text-muted-foreground"> — drag-drop WYSIWYG spikes (mock data, throwaway). Compare the two approaches:</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href="/settings/documents/prototype-pdfme" className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/15">
            pdfme — ready-made designer (Delivery Note & Quotation) →
          </Link>
          <Link href="/settings/documents/prototype-puck" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/15">
            Puck — HTML blocks, keeps your PDF engine (Delivery Note) →
          </Link>
        </div>
      </div>

      <Tabs
        initialKey={tab}
        tabs={[
          { key: "templates", label: "Templates", content: templatesTab },
          { key: "studio", label: "Studio", count: studioDocs.length, content: studioTab },
          { key: "repository", label: "Repository", count: rows.length, content: repositoryTab },
        ]}
      />
    </div>
  );
}
