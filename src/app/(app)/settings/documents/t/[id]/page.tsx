import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ImageUp, Star } from "lucide-react";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import {
  DOC_DEFS,
  SIGNATURE_POSITIONS,
  mergeTemplate,
  isDocKey,
  type DocKey,
} from "@/lib/docTemplates";
import {
  updateDocTemplate,
  uploadTemplateLogo,
  setDefaultDocTemplate,
} from "@/app/actions/documents";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

async function previewUrl(key: DocKey, templateId: string): Promise<string | null> {
  const latestQuote = () => prisma.quote.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  const latestJob = () => prisma.jobCard.findFirst({ orderBy: { openedAt: "desc" }, select: { id: true } });
  switch (key) {
    case "quote": {
      const record = await latestQuote();
      return record ? `/quotes/${record.id}/print?tpl=${templateId}` : null;
    }
    case "invoice": {
      const record = await latestQuote();
      return record ? `/quotes/${record.id}/invoice?tpl=${templateId}` : null;
    }
    case "agreement": {
      const record = await latestQuote();
      return record ? `/quotes/${record.id}/agreement?tpl=${templateId}` : null;
    }
    case "delivery": {
      const record = await latestQuote();
      return record ? `/quotes/${record.id}/delivery-note?tpl=${templateId}` : null;
    }
    case "jobcard": {
      const record = await latestJob();
      return record ? `/jobcards/${record.id}/print?tpl=${templateId}` : null;
    }
    case "service-report": {
      const record = await latestJob();
      return record ? `/jobcards/${record.id}/service-report?tpl=${templateId}` : null;
    }
    case "indemnity": {
      const record = await prisma.lead.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
      return record ? `/leads/${record.id}/indemnity?tpl=${templateId}` : null;
    }
    case "warranty-claim": {
      const record = await prisma.warrantyClaim.findFirst({ orderBy: { claimedAt: "desc" }, select: { id: true } });
      return record ? `/warranty/${record.id}/print?tpl=${templateId}` : null;
    }
  }
}

export default async function TemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("document_templates.manage");
  const { id } = await params;
  const record = await prisma.docTemplateRecord.findUnique({ where: { id } });
  if (!record || record.deletedAt || !isDocKey(record.docType)) notFound();
  const key = record.docType;
  const definition = DOC_DEFS[key];
  const template = mergeTemplate(key, record.config);
  const preview = await previewUrl(key, record.id);
  const input = "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
  const label = "mb-1 block text-xs font-medium text-muted-foreground";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/document-studio" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            Document Studio
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {record.name}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{definition.label}</span>
            {record.isDefault && (
              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                <Star className="size-3" />Default
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {definition.description} This is the operational template used by the CRM&apos;s built-in {definition.label.toLowerCase()} PDF.
          </p>
        </div>
        {!record.isDefault && (
          <form action={setDefaultDocTemplate.bind(null, record.id)}>
            <Button variant="outline" type="submit"><Star className="size-4" />Make default</Button>
          </form>
        )}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[430px_1fr]">
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <p className="mb-2 text-sm font-semibold">Logo</p>
            <div className="mb-3 flex h-16 items-center rounded-lg bg-[#020617] px-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={template.logoUrl ?? "/branding/denago-logo-email.png"} alt="Current logo" className="h-10 w-auto object-contain" />
            </div>
            <form action={uploadTemplateLogo.bind(null, record.id)} className="flex items-center gap-2">
              <input type="file" name="file" accept="image/*" required className="block flex-1 text-xs text-muted-foreground" />
              <Button size="sm" variant="outline" type="submit"><ImageUp className="size-3.5" />Replace</Button>
            </form>
          </div>

          <form action={updateDocTemplate.bind(null, record.id)} className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm">
            <input type="hidden" name="logoUrl" value={template.logoUrl ?? ""} />
            <div>
              <label className={label}>Template name</label>
              <input name="name" defaultValue={record.name} className={input} required />
            </div>
            <div>
              <label className={label}>Intro line beneath the heading</label>
              <input name="intro" defaultValue={template.intro ?? ""} className={input} />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">Visible sections</p>
              <div className="grid grid-cols-2 gap-1.5">
                {definition.sections.map((section) => (
                  <label key={section.id} className="flex items-center gap-2 text-[13px] text-foreground/90">
                    <input type="checkbox" name={`section_${section.id}`} defaultChecked={template.sections[section.id] !== false} className="h-4 w-4 accent-orange-600" />
                    {section.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className={label}>
                {key === "indemnity"
                  ? "Indemnity / waiver text"
                  : key === "agreement"
                    ? "Agreement clauses"
                    : key === "invoice"
                      ? "Banking and payment block"
                      : "Custom document text"}
              </label>
              <textarea name="bodyText" rows={8} defaultValue={template.bodyText ?? ""} className={input} />
              <p className="mt-1 text-[11px] text-muted-foreground">This field changes the custom text block. Structured customer, vehicle, quote and line-item sections are controlled by the section switches above.</p>
            </div>
            {(key === "quote" || key === "invoice") && (
              <div>
                <label className={label}>{key === "quote" ? "Terms and conditions" : "Payment terms"}</label>
                <textarea name="terms" rows={4} defaultValue={template.terms ?? ""} className={input} />
              </div>
            )}
            <div>
              <p className="mb-2 text-sm font-semibold">Signatures</p>
              <select name="sigPosition" defaultValue={template.signature.position} className={input}>
                {SIGNATURE_POSITIONS.map((position) => <option key={position.id} value={position.id}>{position.label}</option>)}
              </select>
              <label className="mt-2 flex items-center gap-2 text-[13px] text-foreground/90">
                <input type="checkbox" name="dealerCounterSign" defaultChecked={template.signature.dealerCounterSign} className="h-4 w-4 accent-orange-600" />
                Show the Denago counter-signature box
              </label>
            </div>
            <div>
              <label className={label}>Footer lines — one per line, maximum four</label>
              <textarea name="footerLines" rows={3} defaultValue={template.footerLines.join("\n")} className={input} />
            </div>
            <Button type="submit">Save operational template</Button>
          </form>
        </div>

        <div className="rounded-xl border border-border bg-card p-2 shadow-sm">
          <div className="mb-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Live preview using the latest available source record. Saving refreshes the template; reload the preview if needed.
          </div>
          {preview ? (
            <iframe src={preview} title="Template preview" className="h-[78vh] w-full rounded-lg bg-white" />
          ) : (
            <p className="p-8 text-center text-sm text-muted-foreground">Nothing to preview yet — create a {definition.label.toLowerCase()} source record first.</p>
          )}
        </div>
      </div>
    </div>
  );
}
