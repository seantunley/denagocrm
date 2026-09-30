import Link from "next/link";
import {
  Copy,
  FileText,
  Layers3,
  PenLine,
  Plus,
  Rocket,
  ScrollText,
  Star,
  Trash2,
  Workflow,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { DOC_DEFS, DOC_GROUPS, type DocKey } from "@/lib/docTemplates";
import { ensureSeeded, listStudioClauses, listTemplates } from "@/lib/docTemplateStore";
import { ensureBuilderSeeded } from "@/lib/docbuilder/store";
import { contactName, formatDate } from "@/lib/format";
import {
  getAccessibleContactIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  hasPermission,
  requireAnyPermission,
  type PermissionUser,
} from "@/lib/permissions";
import {
  createDocTemplate,
  deleteDocTemplate,
  duplicateDocTemplate,
  setDefaultDocTemplate,
} from "@/app/actions/documents";
import {
  createDocInstance,
  createReusableBlock,
  createStudioTemplate,
} from "@/app/actions/studio";
import { WorkspaceHero } from "@/components/workspace-hero";
import { Button, buttonVariants } from "@/components/ui/button";
import BuilderSection from "./builder-section";

export const dynamic = "force-dynamic";

const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });

/**
 * Pickers for "New document". Settings → Documents read these straight from the
 * table because it was owner-only; this page is open to document_templates.manage
 * holders, so every list is RBAC-scoped (createDocInstance re-checks on submit).
 */
async function loadPickers(user: PermissionUser) {
  const [contactIds, quoteIds, leadIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleQuoteIds(user),
    getAccessibleLeadIds(user),
  ]);
  const [contacts, quotes, leads] = await Promise.all([
    prisma.contact.findMany({
      where: scoped(contactIds),
      orderBy: { firstName: "asc" },
      take: 300,
    }),
    prisma.quote.findMany({
      where: { supersededAt: null, ...scoped(quoteIds) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { contact: true },
    }),
    prisma.lead.findMany({
      where: { status: "open", ...scoped(leadIds) },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, name: true, title: true },
    }),
  ]);
  return { contacts, quotes, leads };
}

/**
 * The one list of document templates. Quote print, PDF and e-signing all render
 * the default quote Document Builder layout, so the quote card offers only that —
 * the legacy quote DocTemplateRecord rows are rendered by nothing.
 */
export default async function DocumentStudioPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireAnyPermission("document_templates.manage", "docbuilder.view", "docbuilder.manage");
  const { q } = await searchParams;
  // A Builder-only user (the old Document Builder page's audience) gets the
  // Builder section and nothing that needs document_templates.manage.
  if (!(await hasPermission(user, "document_templates.manage"))) {
    return (
      <div className="space-y-7">
        <WorkspaceHero icon={Layers3} eyebrow="Document operations" title="Document Studio" description="Document layouts you can open with your access." />
        <BuilderSection user={user} q={q} />
      </div>
    );
  }
  const [canCreateDocument, canEditLayout, canSeeBuilder] = await Promise.all([
    // createDocInstance requires documents.manage; don't offer a form that bounces.
    hasPermission(user, "documents.manage"),
    hasPermission(user, "docbuilder.manage"),
    hasAnyPermission(user, "docbuilder.view", "docbuilder.manage"),
    ensureSeeded(),
    ensureBuilderSeeded(),
  ]);
  const keys = (Object.keys(DOC_DEFS) as DocKey[]).filter((key) => key !== "quote");
  const [
    studioTemplates,
    clauses,
    instances,
    quoteBuilder,
    pickers,
    ...typedLists
  ] = await Promise.all([
    prisma.customDocTemplate.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true },
        },
        _count: { select: { instances: true } },
      },
    }),
    listStudioClauses(),
    prisma.docInstance.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 12,
    }),
    prisma.docBuilderTemplate.findFirst({
      where: { key: "quote", deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: { id: true },
    }),
    canCreateDocument ? loadPickers(user) : null,
    ...keys.map((key) => listTemplates(key)),
  ]);
  const typedByKey = Object.fromEntries(
    keys.map((key, index) => [key, typedLists[index]]),
  ) as Record<DocKey, Awaited<ReturnType<typeof listTemplates>>>;

  const input =
    "h-9 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
  const operationalTemplateCount = keys.reduce(
    (total, key) => total + typedByKey[key].length,
    0,
  );

  return (
    <div className="space-y-7">
      <WorkspaceHero
        icon={Layers3}
        eyebrow="Document operations"
        title="Document Studio"
        description="Operational documents and free-form templates are managed separately so every edit has a clear production effect."
        actions={<Link
          href="/documents"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <FileText className="size-4" />
          Open document repository
        </Link>}
        stats={[
          { label: "Operational templates", value: operationalTemplateCount, detail: `${DOC_GROUPS.length} production groups`, icon: Workflow, tone: "primary" },
          { label: "Studio templates", value: studioTemplates.length, detail: "Free-form layouts", icon: Layers3 },
          { label: "Reusable blocks", value: clauses.length, detail: "Shared clauses & content", icon: ScrollText },
          { label: "Recent documents", value: instances.length, detail: "Latest tracked instances", icon: FileText, tone: "success" },
        ]}
      />

      <section className="rounded-2xl border border-orange-500/25 bg-orange-500/[0.06] p-5">
        <h2 className="text-base font-semibold text-foreground">
          1. Operational templates
        </h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
          Quotes use a single Document Builder layout, opened with
          <strong> Edit quote layout</strong> below. The named templates for every
          other document type control their existing print layouts until each
          builder layout reaches visual parity.
        </p>
      </section>

      <div className="space-y-6">
        {DOC_GROUPS.map((group) => (
          <section
            key={group.name}
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">
                {group.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                Named templates feed the matching CRM print/PDF route.
              </p>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              {group.keys.map((key) => {
                const definition = DOC_DEFS[key];
                if (key === "quote") {
                  return (
                    <div
                      key={key}
                      className="rounded-xl border border-border/70 bg-background/30 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-foreground">
                            {definition.label}
                          </p>
                          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                            This one layout is used for quote print, PDF and e-signing.
                          </p>
                        </div>
                        {quoteBuilder && canEditLayout ? (
                          <Button asChild size="sm" className="shrink-0">
                            <Link href={`/doc-editor/${quoteBuilder.id}`}>
                              <PenLine className="size-3.5" />
                              Edit quote layout
                            </Link>
                          </Button>
                        ) : (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {quoteBuilder
                              ? "Editing needs Document Builder access."
                              : "No quote layout yet."}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                }
                const templates = typedByKey[key];
                return (
                  <div
                    key={key}
                    className="rounded-xl border border-border/70 bg-background/30 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-foreground">
                          {definition.label}
                        </p>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                          {definition.description}
                        </p>
                      </div>
                      <span className="shrink-0 rounded bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Built-in
                      </span>
                    </div>
                    <ul className="mt-3 divide-y divide-border/50">
                      {templates.map((template) => (
                        <li
                          key={template.id}
                          className="flex items-center gap-2 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/settings/documents/t/${template.id}`}
                              className="truncate text-[13px] font-medium text-foreground hover:text-primary"
                            >
                              {template.name}
                            </Link>
                            {template.isDefault && (
                              <span className="ml-2 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                <Star className="size-3" />
                                Default
                              </span>
                            )}
                          </div>
                          <Button asChild variant="outline" size="sm">
                            <Link
                              href={`/settings/documents/t/${template.id}`}
                            >
                              <PenLine className="size-3.5" />
                              Edit
                            </Link>
                          </Button>
                          {!template.isDefault && (
                            <form action={setDefaultDocTemplate.bind(null, template.id)}>
                              <Button variant="ghost" size="sm" title="Make default" aria-label={`Make ${template.name} the default`}>
                                <Star className="size-3.5" />
                              </Button>
                            </form>
                          )}
                          <form action={duplicateDocTemplate.bind(null, template.id)}>
                            <Button variant="ghost" size="sm" title="Duplicate" aria-label={`Duplicate ${template.name}`}>
                              <Copy className="size-3.5" />
                            </Button>
                          </form>
                          {!template.isDefault && (
                            <form action={deleteDocTemplate.bind(null, template.id)}>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-400 hover:text-red-300"
                                title="Delete"
                                aria-label={`Delete ${template.name}`}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </form>
                          )}
                        </li>
                      ))}
                    </ul>
                    <form
                      action={createDocTemplate}
                      className="mt-3 flex flex-wrap gap-2"
                    >
                      <input type="hidden" name="docType" value={key} />
                      <input
                        name="name"
                        required
                        placeholder={`New ${definition.label.toLowerCase()} template…`}
                        className={`${input} min-w-48 flex-1`}
                      />
                      <select name="baseId" defaultValue="" className={input}>
                        <option value="">Start from standard</option>
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            Copy {template.name}
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

      <section className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.05] p-5">
        <h2 className="text-base font-semibold text-foreground">
          2. Free-form Studio
        </h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
          This editor creates standalone documents from blocks, clauses and merge
          fields. Use it for custom proposals, letters, handover packs and
          documents without a dedicated CRM screen.
        </p>
      </section>

      {pickers && (
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold">New document</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Pick a template (or start blank) and link the customer — merge fields
            fill in automatically and are frozen into the document.
          </p>
          <form action={createDocInstance} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <input name="title" required placeholder="Document title…" aria-label="Document title" className={`${input} xl:col-span-2`} />
            <select name="templateId" aria-label="Template" className={input} defaultValue="">
              <option value="">Blank document</option>
              {studioTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.versions[0] ? ` (v${template.versions[0].version})` : " (draft)"}
                </option>
              ))}
            </select>
            <select name="contactId" aria-label="Customer" className={input} defaultValue="">
              <option value="">Customer (optional)…</option>
              {pickers.contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contactName(contact)}
                </option>
              ))}
            </select>
            <select name="quoteId" aria-label="Quote" className={input} defaultValue="">
              <option value="">Quote (optional)…</option>
              {pickers.quotes.map((quote) => (
                <option key={quote.id} value={quote.id}>
                  Q-{quote.number}
                  {quote.contact ? ` — ${contactName(quote.contact)}` : ""}
                </option>
              ))}
            </select>
            <select name="leadId" aria-label="Deal" className={input} defaultValue="">
              <option value="">Deal (optional)…</option>
              {pickers.leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.title || lead.name}
                </option>
              ))}
            </select>
            <Button type="submit">
              <Plus className="size-4" />
              Create document
            </Button>
          </form>
        </section>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Rocket className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Free-form templates</h3>
          </div>
          <ul className="divide-y divide-border/50">
            {studioTemplates.length === 0 && (
              <li className="py-3 text-xs text-muted-foreground">
                No free-form templates yet.
              </li>
            )}
            {studioTemplates.map((template) => (
              <li
                key={template.id}
                className="flex items-center gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/settings/documents/studio/t/${template.id}`}
                    className="truncate text-[13px] font-medium hover:text-primary"
                  >
                    {template.name}
                  </Link>
                  <p className="text-[11px] text-muted-foreground">
                    {template.versions[0]
                      ? `v${template.versions[0].version} published`
                      : "Draft only"}{" "}
                    · {template._count.instances} document
                    {template._count.instances === 1 ? "" : "s"}
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/settings/documents/studio/t/${template.id}`}
                  >
                    <PenLine className="size-3.5" />
                    Edit
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          <form action={createStudioTemplate} className="mt-3 flex gap-2">
            <input
              name="name"
              required
              placeholder="New free-form template…"
              className={`${input} flex-1`}
            />
            <Button size="sm" type="submit">
              <Plus className="size-3.5" />
              Create
            </Button>
          </form>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <ScrollText className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Reusable clauses</h3>
          </div>
          <p className="mb-2 text-xs leading-5 text-muted-foreground">
            Reusable clauses work only inside the free-form Studio. They are
            copied into a document when inserted.
          </p>
          <ul className="divide-y divide-border/50">
            {clauses.length === 0 && (
              <li className="py-3 text-xs text-muted-foreground">
                No reusable clauses yet.
              </li>
            )}
            {clauses.map((clause) => (
              <li
                key={clause.id}
                className="flex items-center gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/settings/documents/studio/c/${clause.id}`}
                    className="truncate text-[13px] font-medium hover:text-primary"
                  >
                    {clause.name}
                  </Link>
                  <p className="text-[11px] text-muted-foreground">
                    Edited {formatDate(clause.updatedAt)}
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/settings/documents/studio/c/${clause.id}`}
                  >
                    <PenLine className="size-3.5" />
                    Edit
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          <form action={createReusableBlock} className="mt-3 flex gap-2">
            <input
              name="name"
              required
              placeholder="New reusable clause…"
              className={`${input} flex-1`}
            />
            <Button size="sm" type="submit">
              <Plus className="size-3.5" />
              Create
            </Button>
          </form>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold">
          Recent free-form documents
        </h3>
        <ul className="divide-y divide-border/50">
          {instances.length === 0 && (
            <li className="py-3 text-xs text-muted-foreground">
              No free-form documents have been generated yet.
            </li>
          )}
          {instances.map((instance) => (
            <li
              key={instance.id}
              className="flex items-center gap-3 py-2"
            >
              <FileText className="size-4 text-muted-foreground" />
              <Link
                href={`/settings/documents/studio/d/${instance.id}`}
                className="min-w-0 flex-1 truncate text-[13px] font-medium hover:text-primary"
              >
                {instance.title}
              </Link>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                {instance.status}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {formatDate(instance.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {canSeeBuilder && <BuilderSection user={user} q={q} />}
    </div>
  );
}
