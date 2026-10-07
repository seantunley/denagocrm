import Link from "next/link";
import {
  FileText,
  Layers3,
  PenLine,
  Plus,
  Rocket,
  ScrollText,
  Sparkles,
  Workflow,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { DOC_DEFS, docGroupsForModules, docKeyAvailable, type DocKey } from "@/lib/docTemplates";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { ensureSeeded, listStudioClauses } from "@/lib/docTemplateStore";
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
import { createReusableBlock } from "@/app/actions/studio";
import { convertStudioTemplate, createCustomDocument } from "@/app/actions/customDocuments";
import { createDocEditorTemplate } from "@/app/actions/doceditor";
import { WorkspaceHero } from "@/components/workspace-hero";
import { Button, buttonVariants } from "@/components/ui/button";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { SaveSubmitButton } from "@/components/SaveSubmitButton";
import BuilderSection from "./builder-section";
import ContactPicker from "@/components/ContactPicker";

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
    // createCustomDocument requires documents.manage; don't offer a form that bounces.
    hasPermission(user, "documents.manage"),
    hasPermission(user, "docbuilder.manage"),
    hasAnyPermission(user, "docbuilder.view", "docbuilder.manage"),
    ensureSeeded(),
    ensureBuilderSeeded(),
  ]);
  // Only the documents this workspace has: job cards, service reports, warranty
  // claims, test-drive indemnities and delivery notes need the automotive module.
  const enabledModules = await getEnabledModuleIds();
  const docGroups = docGroupsForModules(enabledModules);
  const keys = (Object.keys(DOC_DEFS) as DocKey[]).filter((key) => docKeyAvailable(key, enabledModules));
  const [
    studioTemplates,
    clauses,
    instances,
    layoutRows,
    customTemplates,
    pickers,
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
    prisma.docInstance
      .findMany({
        where: { deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 12,
        select: { id: true, title: true, status: true, updatedAt: true, docModelJson: true },
      })
      // Which editor opens it: a document-editor model, or a legacy Studio one.
      .then((rows) => rows.map(({ docModelJson, ...row }) => ({ ...row, editorDocument: docModelJson != null }))),
    // Each document's one layout in the document editor (its default), and
    // whether it is live yet.
    prisma.docBuilderTemplate.findMany({
      where: { key: { in: keys }, deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: { id: true, key: true, publishedVersion: true },
    }),
    // Doc-editor templates a custom document can be made from.
    prisma.docBuilderTemplate.findMany({
      where: { key: "custom", deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, publishedVersion: true, updatedAt: true },
    }),
    canCreateDocument ? loadPickers(user) : null,
  ]);
  // Ordered default-first, so the first row per document is its layout.
  const layoutByKey = new Map<string, (typeof layoutRows)[number]>();
  for (const row of layoutRows) if (!layoutByKey.has(row.key)) layoutByKey.set(row.key, row);

  const input =
    "h-9 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
  const operationalTemplateCount = keys.length;

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
          { label: "Operational templates", value: operationalTemplateCount, detail: `${docGroups.length} production groups`, icon: Workflow, tone: "primary" },
          { label: "Custom templates", value: customTemplates.length, detail: `${studioTemplates.length} legacy Studio`, icon: Layers3 },
          { label: "Reusable blocks", value: clauses.length, detail: "Shared clauses & content", icon: ScrollText },
          { label: "Recent documents", value: instances.length, detail: "Latest tracked instances", icon: FileText, tone: "success" },
        ]}
      />

      <section className="rounded-2xl border border-orange-500/25 bg-orange-500/[0.06] p-5">
        <h2 className="text-base font-semibold text-foreground">
          1. Operational templates
        </h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
          Every document has one layout, edited in the document editor — its
          design, its wording, bank details, terms and clauses, all in one place.
          Your logo and company details come from your company profile. A document
          prints its new layout once you <strong>Publish</strong> it there; until then
          it keeps printing as it does today.
        </p>
      </section>

      <div className="space-y-6">
        {docGroups.map((group) => (
          <section
            key={group.name}
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">
                {group.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                One layout per document, edited in the document editor.
              </p>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              {group.keys.map((key) => {
                const definition = DOC_DEFS[key];
                const layout = layoutByKey.get(key);
                // The quote prints from this layout even unpublished (its draft);
                // every other document waits for Publish (publishedBuilderTemplateFor).
                const live = layout?.publishedVersion != null || (key === "quote" && Boolean(layout));
                return (
                  <div
                    key={key}
                    className="rounded-xl border border-border/70 bg-background/30 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">
                          {definition.label}
                          <span
                            className={`ml-2 rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide ${live ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}
                          >
                            {live ? "Live" : "Not published yet"}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                          {key === "quote" ? "Used for quote print, PDF and e-signing." : definition.description}
                        </p>
                        {!live && layout && (
                          <p className="mt-1 text-xs leading-5 text-amber-600">
                            Still printing its previous layout. Open it, check it, and press Publish to switch.
                          </p>
                        )}
                      </div>
                      {layout && canEditLayout ? (
                        <Button asChild size="sm" className="shrink-0">
                          <Link href={`/doc-editor/${layout.id}`}>
                            <PenLine className="size-3.5" />
                            Edit layout &amp; wording
                          </Link>
                        </Button>
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {layout ? "Editing needs Document Builder access." : "No layout yet."}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <section className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.05] p-5">
        <h2 className="text-base font-semibold text-foreground">
          2. Custom documents
        </h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
          Standalone documents — proposals, letters, handover packs — made in the
          document editor from a custom template and linked to a customer, quote
          or deal. Each document is its own copy: editing it never changes the
          template, and <strong>Finalise</strong> files the PDF and locks it.
          The older Studio free-form editor is kept for existing documents; use
          <strong> Convert to new editor</strong> to bring its templates across.
        </p>
      </section>

      {pickers && (
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold">New document</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Pick a custom template (or start blank) and link the customer — merge fields
            fill in automatically and are frozen into the document.
          </p>
          <SaveForm action={createCustomDocument} success="Document created" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <input name="title" placeholder="Document title (optional)…" aria-label="Document title" className={`${input} xl:col-span-2`} />
            <select name="templateId" aria-label="Template" className={input} defaultValue="">
              <option value="">Blank document</option>
              {customTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.publishedVersion ? ` (v${template.publishedVersion})` : " (draft)"}
                </option>
              ))}
            </select>
            <ContactPicker
              name="contactId"
              options={pickers.contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
              emptyLabel="Customer (optional)…"
            />
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
            <SaveSubmitButton>
              <Plus className="size-4" />
              Create document
            </SaveSubmitButton>
          </SaveForm>
        </section>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Rocket className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Custom templates</h3>
          </div>
          <ul className="divide-y divide-border/50">
            {customTemplates.length === 0 && (
              <li className="py-3 text-xs text-muted-foreground">
                No custom templates yet — create one, or convert a Studio template below.
              </li>
            )}
            {customTemplates.map((template) => (
              <li key={template.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{template.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {template.publishedVersion ? `v${template.publishedVersion} published` : "Not published — documents use the draft"}
                    {" · "}edited {formatDate(template.updatedAt)}
                  </p>
                </div>
                {canEditLayout && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/doc-editor/${template.id}`}>
                      <PenLine className="size-3.5" />
                      Edit
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canEditLayout && (
            <SaveForm action={createDocEditorTemplate} success="Template created" className="mt-3 flex gap-2">
              <input type="hidden" name="key" value="custom" />
              <input name="name" required placeholder="New custom template…" className={`${input} flex-1`} />
              <SaveSubmitButton size="sm">
                <Plus className="size-3.5" />
                Create
              </SaveSubmitButton>
            </SaveForm>
          )}

          <div className="mt-5 flex items-center gap-2">
            <h3 className="text-sm font-semibold">Studio free-form templates</h3>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">Legacy</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The old free-form editor. <strong>Convert to new editor</strong> copies a
            template into a new custom template; the original is kept unchanged.
          </p>
          <ul className="divide-y divide-border/50">
            {studioTemplates.length === 0 && (
              <li className="py-3 text-xs text-muted-foreground">
                No Studio templates.
              </li>
            )}
            {studioTemplates.map((template) => (
              <li
                key={template.id}
                className="flex flex-wrap items-center gap-2 py-2"
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
                {canEditLayout && (
                  <SaveForm
                    action={convertStudioTemplate.bind(null, template.id)}
                    success="Converted — opening it in the document editor"
                    resetOnSuccess={false}
                  >
                    <SaveSubmitButton size="sm" title="Copy this template into the document editor as a custom template">
                      <Sparkles className="size-3.5" />
                      Convert to new editor
                    </SaveSubmitButton>
                  </SaveForm>
                )}
                <Button asChild variant="ghost" size="sm">
                  <Link
                    href={`/settings/documents/studio/t/${template.id}`}
                  >
                    <PenLine className="size-3.5" />
                    Edit (legacy)
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <ScrollText className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Clause library</h3>
          </div>
          <p className="mb-2 text-xs leading-5 text-muted-foreground">
            Insert a clause from the document editor&apos;s <strong>Library</strong> tab
            (or a legacy Studio document). It is copied in when inserted, so
            editing a clause here never changes existing documents.
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
          <SaveForm action={createReusableBlock} className="mt-3 flex gap-2">
            <input
              name="name"
              required
              placeholder="New reusable clause…"
              className={`${input} flex-1`}
            />
            <SaveButton className={buttonVariants({ size: "sm" })} pendingLabel="Creating…">
              <Plus className="size-3.5" />
              Create
            </SaveButton>
          </SaveForm>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold">
          Recent custom documents
        </h3>
        <ul className="divide-y divide-border/50">
          {instances.length === 0 && (
            <li className="py-3 text-xs text-muted-foreground">
              No custom documents have been created yet.
            </li>
          )}
          {instances.map((instance) => (
            <li
              key={instance.id}
              className="flex items-center gap-3 py-2"
            >
              <FileText className="size-4 text-muted-foreground" />
              <Link
                href={instance.editorDocument ? `/doc-editor/document/${instance.id}` : `/settings/documents/studio/d/${instance.id}`}
                className="min-w-0 flex-1 truncate text-[13px] font-medium hover:text-primary"
              >
                {instance.title}
              </Link>
              {!instance.editorDocument && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                  Studio (legacy)
                </span>
              )}
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
