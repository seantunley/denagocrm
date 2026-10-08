import { notFound } from "next/navigation";
import { getAccessibleJobCardIds, getAccessibleLeadIds, getAccessibleQuoteIds, getAccessibleVehicleIds, requireAnyPermission } from "@/lib/permissions";
import { requireLayoutEditor } from "@/lib/docbuilder/layoutAccess";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getBuilderTemplate, withLegacyTextInlined } from "@/lib/docbuilder/store";
import { requiredRecordKind } from "@/lib/docbuilder/recordBinding";
import Link from "next/link";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { DocEditor, type PublishState } from "@/components/doceditor/DocEditor";
import { STANDARD_TEMPLATE_KEYS } from "@/lib/doceditor/standardTemplates";
import { DocEditorEnvProvider } from "@/components/doceditor/EditorContext";
import { getCompanyProfile } from "@/lib/companyProfile";
import { documentLogo } from "@/lib/doceditor/renderGlobals";
import { quoteWordingSettings } from "@/lib/quoteFromLead";
import { getActiveTenantId } from "@/lib/auth";
import { EMAIL_FRAME_KEY, EMAIL_SAMPLE_FIELDS, emailKindOf } from "@/lib/doceditor/emailDefaults";
import { emailBrandFor } from "@/lib/doceditor/emailDocuments";
import { MESSAGE_PLACES, messagePlace } from "@/lib/customerMessagePlaces";
import { SIGNING_EMAILS } from "@/lib/signing/emailTemplates";

export const dynamic = "force-dynamic";

/** Does the saved draft match what real documents (or emails) use — the published version? */
async function publishStateOf(template: { id: string; data: unknown; publishedVersion: number | null }): Promise<PublishState> {
  const published = template.publishedVersion == null
    ? null
    : await prisma.docBuilderVersion.findUnique({
        where: { templateId_version: { templateId: template.id, version: template.publishedVersion } },
        select: { data: true },
      });
  return !published ? "never" : JSON.stringify(published.data) === JSON.stringify(template.data) ? "live" : "ahead";
}

export default async function DocEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAnyPermission("docbuilder.manage", "document_templates.manage");
  const { id } = await params;
  // An invoice/agreement still reading its text from the old form editor opens
  // with it written in, so bank details and clauses are edited in this editor
  // (stored by the editor's save, or by Publish — nothing is written on open).
  const template = await getBuilderTemplate(id).then((t) => (t ? withLegacyTextInlined(t) : null));
  if (!template) notFound();
  // docbuilder.manage, or — for the seven layouts the old form editor managed —
  // document_templates.manage (layoutAccess).
  const user = await requireLayoutEditor(template.key);

  const read = readTemplateDocument(template.data, template.name);

  // THIS EDITOR AUTOSAVES. Mounting it means the stored row is one keystroke
  // from being replaced by whatever is on screen, so it may only ever be
  // mounted on content that parsed — never on a fallback.
  //
  // Both failures are refusals, not just "unsupported". An "unreadable" row is
  // not a blank row: `saveBuilderData` used to write `data: unknown` to this
  // column with no validation, and a current-format document with one bad field
  // lands there too. Opening either blank is how the stored content would be
  // lost — the same failure this whole change exists to stop, one status over.
  //
  // A blank document is created explicitly, by createDocEditorTemplate, as a
  // validated DocumentModel. It is never something an editor load falls into.
  if (read.status !== "ok") {
    return (
      <div className="mx-auto max-w-lg space-y-3 p-8">
        <h1 className="text-lg font-semibold text-foreground">
          “{template.name}” can’t be opened in the editor
        </h1>
        <p className="text-sm text-muted-foreground">
          {read.status === "unsupported"
            ? "It was built in the previous document builder and uses a layout this editor can’t represent yet."
            : "Its saved content isn’t in a format this editor recognises."}{" "}
          Nothing has been changed — the template is stored exactly as it was,
          and it is not being opened here because saving over it would lose
          whatever it holds.
        </p>
        <p className="text-sm text-muted-foreground">
          Create a new document to replace it, or send this template name to
          support so the content can be recovered.
        </p>
        <Link href="/document-studio" className="inline-block text-sm text-primary hover:underline">
          Back to Document Studio
        </Link>
      </div>
    );
  }

  const initialDoc = read.doc;

  // A customer EMAIL (the shared frame, or one message): the editor in email
  // mode — the workspace's email look on the canvas, only that message's fields,
  // a Subject line, and no print tools. Owner-only (layoutAccess.ts).
  const emailKind = emailKindOf(template.key);
  if (emailKind || template.key === EMAIL_FRAME_KEY) {
    // The acting workspace, from the session; the template is its own (getBuilderTemplate
    // refuses another workspace's email) — and the brand shown is read for that tenant only.
    const tenantId = await getActiveTenantId();
    if (!tenantId || template.tenantId !== tenantId) notFound();
    const brand = await emailBrandFor(tenantId);
    const place = emailKind ? messagePlace(emailKind) : "automatic";
    const backHref = place === "documents" ? "/document-studio#document-emails" : MESSAGE_PLACES[place].path;
    return (
      <DocEditorEnvProvider
        value={{
          templateId: template.id,
          logoSrc: "",
          companyName: brand.companyName,
          email: {
            kind: emailKind,
            fields: emailKind ? [...SIGNING_EMAILS[emailKind].fields] : [],
            sample: { ...EMAIL_SAMPLE_FIELDS, company_name: brand.companyName, company_phone: brand.phone, company_email: brand.email },
            brand,
          },
        }}
      >
        <DocEditor id={template.id} initialDoc={initialDoc} records={[]} initialPublishState={await publishStateOf(template)} email={{ frame: !emailKind, backHref }} />
      </DocEditorEnvProvider>
    );
  }

  const required = requiredRecordKind(template.key);
  // Every preview record is scoped to what the caller may see (as BuilderSection
  // does): the editor is open to document_templates.manage holders too
  // (layoutAccess), who may hold no quotes or workshop permission at all — and
  // the labels carry customer names, quote and job numbers, vehicle models.
  const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
  const [quotes, jobCards, leads, claims] = await Promise.all([
    required !== "quote" && required !== "either"
      ? []
      : getAccessibleQuoteIds(user).then((ids) =>
          prisma.quote.findMany({
            where: { supersededAt: null, ...scoped(ids) },
            orderBy: { createdAt: "desc" },
            take: 100,
            include: { contact: true },
          })),
    required !== "jobcard" && required !== "either"
      ? []
      : getAccessibleJobCardIds(user).then((ids) =>
          prisma.jobCard.findMany({
            where: scoped(ids),
            orderBy: { openedAt: "desc" },
            take: 100,
            include: { contact: true, vehicle: true },
          })),
    // Scoped to the leads / vehicles the caller may see, as the print pages are.
    required !== "lead"
      ? []
      : getAccessibleLeadIds(user).then((ids) =>
          prisma.lead.findMany({
            where: ids === null ? {} : { id: { in: ids } },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: { id: true, name: true, title: true },
          })),
    required !== "warranty"
      ? []
      : getAccessibleVehicleIds(user).then((ids) =>
          prisma.warrantyClaim.findMany({
            where: ids === null ? {} : { vehicleId: { in: ids } },
            orderBy: { claimedAt: "desc" },
            take: 100,
            select: { id: true, vehicle: { select: { model: true } } },
          })),
  ]);
  const records = [
    ...quotes.map((quote) => ({
      value: `quote:${quote.id}`,
      label: `Quote Q-${quote.number}${quote.contact ? ` — ${contactName(quote.contact)}` : ""}`,
    })),
    ...jobCards.map((jobCard) => ({
      value: `jobcard:${jobCard.id}`,
      label: `Job #${jobCard.number} — ${contactName(jobCard.contact)} — ${jobCard.vehicle.model}`,
    })),
    ...leads.map((lead) => ({
      value: `lead:${lead.id}`,
      label: `Lead — ${lead.name} — ${lead.title}`,
    })),
    ...claims.map((claim) => ({
      value: `warranty:${claim.id}`,
      label: `Warranty claim WC-${claim.id.slice(-6).toUpperCase()} — ${claim.vehicle.model}`,
    })),
  ];

  const publishState = await publishStateOf(template);

  // The canvas shows the same embedded logo the printed document will carry.
  const company = await getCompanyProfile();
  const logoSrc = (await documentLogo(company.logoUrl)) ?? "";
  // Quote-bound layouts get warned about typed-in validity/VAT wording that
  // contradicts the settings (see doceditor/wordingCheck).
  const wordingSettings = required === "quote" ? await quoteWordingSettings() : undefined;

  return (
    <DocEditorEnvProvider value={{ templateId: template.id, logoSrc, companyName: company.name }}>
      <DocEditor
        id={template.id}
        initialDoc={initialDoc}
        records={records}
        initialPublishState={publishState}
        hasStandardLayout={(STANDARD_TEMPLATE_KEYS as string[]).includes(template.key)}
        wordingSettings={wordingSettings}
      />
    </DocEditorEnvProvider>
  );
}
