import Link from "next/link";
import {
  FileText,
  Layers3,
  PenLine,
  Plus,
  Rocket,
  Workflow,
} from "lucide-react";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DOC_DEFS, docGroupsForModules, docKeyAvailable, type DocKey } from "@/lib/docTemplates";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { ensureSeeded } from "@/lib/docTemplateStore";
import { ensureBuilderSeeded } from "@/lib/docbuilder/store";
import { FORM_EDITOR_KEYS } from "@/lib/docbuilder/layoutAccess";
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
import { createCustomDocument } from "@/app/actions/customDocuments";
import { createDocEditorTemplate } from "@/app/actions/doceditor";
import { WorkspaceHero } from "@/components/workspace-hero";
import { Button, buttonVariants } from "@/components/ui/button";
import { SaveForm } from "@/components/SaveForm";
import { SaveSubmitButton } from "@/components/SaveSubmitButton";
import BuilderSection from "./builder-section";
import ContactPicker from "@/components/ContactPicker";
import CustomerMessageEditors from "@/components/CustomerMessageEditors";
import EmailDesignCards from "@/components/EmailDesignCards";
import { emailKindsAt, textKindsAt } from "@/lib/customerMessagePlaces";
import { isTenantOwner } from "@/lib/auth";

export const dynamic = "force-dynamic";

const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });

/**
 * Pickers for "New document". Settings → Documents read these straight from the
 * table because it was owner-only; this page is open to document_templates.manage
 * holders, so every list is RBAC-scoped (createCustomDocument re-checks on submit).
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
  searchParams: Promise<{ q?: string; open?: string }>;
}) {
  const user = await requireAnyPermission("document_templates.manage", "docbuilder.view", "docbuilder.manage");
  const { q, open } = await searchParams;
  const isOwner = await isTenantOwner();
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
    instances,
    layoutRows,
    customTemplates,
    pickers,
  ] = await Promise.all([
    // Documents made in the document editor — the only editor there is.
    prisma.docInstance.findMany({
      where: { deletedAt: null, docModelJson: { not: Prisma.AnyNull } },
      orderBy: { updatedAt: "desc" },
      take: 12,
      select: { id: true, title: true, status: true, updatedAt: true },
    }),
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
        description="Every document — operational and custom — is designed and worded in the one document editor."
        actions={<Link
          href="/documents"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <FileText className="size-4" />
          Open document repository
        </Link>}
        stats={[
          { label: "Operational templates", value: operationalTemplateCount, detail: `${docGroups.length} production groups`, icon: Workflow, tone: "primary" },
          { label: "Custom templates", value: customTemplates.length, detail: "Proposals, letters, packs", icon: Layers3 },
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
                // Everyone here holds document_templates.manage (the early return
                // above), which edits the seven old form-editor layouts (layoutAccess).
                const editable = canEditLayout || FORM_EDITOR_KEYS.has(key);
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
                      {layout && editable ? (
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

      {/* The emails that SEND these documents, next to the documents (Sean,
          2026-10-07: templates "buried in settings under email"). Owner-only,
          like the actions behind them. Linked as /document-studio?open=<kind>. */}
      {isOwner && (
        <section id="document-emails" className="scroll-mt-24 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-foreground">Emails that send your documents</h3>
            <p className="text-xs text-muted-foreground">
              The quote email and the signing invitation, reminder, signed copy and code — the wording your customer
              reads with each document. Logo, colour and footer come from your company profile.
            </p>
          </div>
          {/* Emails open in the document editor, like the documents above; WhatsApp texts stay text. */}
          <EmailDesignCards kinds={emailKindsAt("documents")} frame />
          <div className="mt-3">
            <CustomerMessageEditors kinds={textKindsAt("documents")} open={open} />
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.05] p-5">
        <h2 className="text-base font-semibold text-foreground">
          2. Custom documents
        </h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
          Standalone documents — proposals, letters, handover packs — made in the
          document editor from a custom template and linked to a customer, quote
          or deal. Each document is its own copy: editing it never changes the
          template, and <strong>Finalise</strong> files the PDF and locks it.
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
                No custom templates yet — create one below.
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
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Reusable clauses live in the document editor&apos;s <strong>Library</strong> tab:
            save a block there, insert it into any document or template.
          </p>
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
                href={`/doc-editor/document/${instance.id}`}
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
