import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ImageUp, Star } from "lucide-react";
import { requireOwner } from "@/lib/auth";
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

/** Where each type's live preview comes from (latest real record). */
async function previewUrl(key: DocKey, tplId: string): Promise<string | null> {
  const q = () => prisma.quote.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  const j = () => prisma.jobCard.findFirst({ orderBy: { openedAt: "desc" }, select: { id: true } });
  switch (key) {
    case "quote": {
      const r = await q();
      return r ? `/quotes/${r.id}/print?tpl=${tplId}` : null;
    }
    case "invoice": {
      const r = await q();
      return r ? `/quotes/${r.id}/invoice?tpl=${tplId}` : null;
    }
    case "agreement": {
      const r = await q();
      return r ? `/quotes/${r.id}/agreement?tpl=${tplId}` : null;
    }
    case "delivery": {
      const r = await q();
      return r ? `/quotes/${r.id}/delivery-note?tpl=${tplId}` : null;
    }
    case "jobcard": {
      const r = await j();
      return r ? `/jobcards/${r.id}/print?tpl=${tplId}` : null;
    }
    case "service-report": {
      const r = await j();
      return r ? `/jobcards/${r.id}/service-report?tpl=${tplId}` : null;
    }
    case "indemnity": {
      const r = await prisma.lead.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
      return r ? `/leads/${r.id}/indemnity?tpl=${tplId}` : null;
    }
    case "warranty-claim": {
      const r = await prisma.warrantyClaim.findFirst({
        orderBy: { claimedAt: "desc" },
        select: { id: true },
      });
      return r ? `/warranty/${r.id}/print?tpl=${tplId}` : null;
    }
  }
}

export default async function TemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const rec = await prisma.docTemplateRecord.findUnique({ where: { id } });
  if (!rec || rec.deletedAt || !isDocKey(rec.docType)) notFound();
  const key = rec.docType;
  const def = DOC_DEFS[key];
  const tpl = mergeTemplate(key, rec.config);
  const preview = await previewUrl(key, rec.id);

  const input =
    "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
  const label = "mb-1 block text-xs font-medium text-muted-foreground";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/settings/documents"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Documents
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {rec.name}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {def.label}
            </span>
            {rec.isDefault && (
              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                <Star className="size-3" />
                Default
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {def.description} The preview renders your latest real record with THIS template.
          </p>
        </div>
        {!rec.isDefault && (
          <form action={setDefaultDocTemplate.bind(null, rec.id)}>
            <Button variant="outline" type="submit">
              <Star className="size-4" />
              Make default
            </Button>
          </form>
        )}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[430px_1fr]">
        <div className="space-y-4">
          {/* Logo */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <p className="mb-2 text-sm font-semibold">Logo</p>
            <div className="mb-3 flex h-16 items-center rounded-lg bg-[#020617] px-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={tpl.logoUrl ?? "/branding/denago-logo-email.png"}
                alt="Current logo"
                className="h-10 w-auto object-contain"
              />
            </div>
            <form action={uploadTemplateLogo.bind(null, rec.id)} className="flex items-center gap-2">
              <input
                type="file"
                name="file"
                accept="image/*"
                required
                className="block flex-1 text-xs text-muted-foreground"
              />
              <Button size="sm" variant="outline" type="submit">
                <ImageUp className="size-3.5" />
                Replace
              </Button>
            </form>
          </div>

          {/* Everything else — one form, one save */}
          <form
            action={updateDocTemplate.bind(null, rec.id)}
            className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <input type="hidden" name="logoUrl" value={tpl.logoUrl ?? ""} />

            <div>
              <label className={label}>Template name</label>
              <input name="name" defaultValue={rec.name} className={input} required />
            </div>

            <div>
              <label className={label}>Intro line (under the header)</label>
              <input name="intro" defaultValue={tpl.intro ?? ""} className={input} />
            </div>

            <div>
              <p className="mb-2 text-sm font-semibold">Sections</p>
              <div className="grid grid-cols-2 gap-1.5">
                {def.sections.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-[13px] text-foreground/90">
                    <input
                      type="checkbox"
                      name={`section_${s.id}`}
                      defaultChecked={tpl.sections[s.id] !== false}
                      className="h-4 w-4 accent-orange-600"
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className={label}>
                Document text{" "}
                {key === "indemnity"
                  ? "(the waiver itself)"
                  : key === "agreement"
                    ? "(the contract clauses)"
                    : key === "invoice"
                      ? "(banking details)"
                      : "(optional block above the signatures)"}
              </label>
              <textarea name="bodyText" rows={6} defaultValue={tpl.bodyText ?? ""} className={input} />
            </div>

            {(key === "quote" || key === "invoice") && (
              <div>
                <label className={label}>
                  {key === "quote" ? "Terms & conditions (blank = standard)" : "Payment terms"}
                </label>
                <textarea name="terms" rows={3} defaultValue={tpl.terms ?? ""} className={input} />
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-semibold">Signatures</p>
              <select name="sigPosition" defaultValue={tpl.signature.position} className={input}>
                {SIGNATURE_POSITIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <label className="mt-2 flex items-center gap-2 text-[13px] text-foreground/90">
                <input
                  type="checkbox"
                  name="dealerCounterSign"
                  defaultChecked={tpl.signature.dealerCounterSign}
                  className="h-4 w-4 accent-orange-600"
                />
                Show the Denago signature box
              </label>
            </div>

            <div>
              <label className={label}>Footer lines (one per line, max 4)</label>
              <textarea
                name="footerLines"
                rows={2}
                defaultValue={tpl.footerLines.join("\n")}
                className={input}
              />
            </div>

            <Button type="submit">Save template</Button>
          </form>
        </div>

        {/* Live preview */}
        <div className="rounded-xl border border-border bg-card p-2 shadow-sm">
          {preview ? (
            <iframe src={preview} title="Template preview" className="h-[78vh] w-full rounded-lg bg-white" />
          ) : (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Nothing to preview yet — create a {def.label.toLowerCase()} source record first.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
