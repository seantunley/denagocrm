import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  ImageUp,
  LayoutTemplate,
  Palette,
  Star,
  Type,
} from "lucide-react";
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

/** Preview the template with the latest real source record of its type. */
async function previewUrl(key: DocKey, tplId: string): Promise<string | null> {
  const q = () => prisma.quote.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  const j = () => prisma.jobCard.findFirst({ orderBy: { openedAt: "desc" }, select: { id: true } });
  switch (key) {
    case "quote": { const r = await q(); return r ? `/quotes/${r.id}/print?tpl=${tplId}` : null; }
    case "invoice": { const r = await q(); return r ? `/quotes/${r.id}/invoice?tpl=${tplId}` : null; }
    case "agreement": { const r = await q(); return r ? `/quotes/${r.id}/agreement?tpl=${tplId}` : null; }
    case "delivery": { const r = await q(); return r ? `/quotes/${r.id}/delivery-note?tpl=${tplId}` : null; }
    case "jobcard": { const r = await j(); return r ? `/jobcards/${r.id}/print?tpl=${tplId}` : null; }
    case "service-report": { const r = await j(); return r ? `/jobcards/${r.id}/service-report?tpl=${tplId}` : null; }
    case "indemnity": {
      const r = await prisma.lead.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
      return r ? `/leads/${r.id}/indemnity?tpl=${tplId}` : null;
    }
    case "warranty-claim": {
      const r = await prisma.warrantyClaim.findFirst({ orderBy: { claimedAt: "desc" }, select: { id: true } });
      return r ? `/warranty/${r.id}/print?tpl=${tplId}` : null;
    }
  }
}

export default async function TemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  await requireOwner();
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  const rec = await prisma.docTemplateRecord.findUnique({ where: { id } });
  if (!rec || rec.deletedAt || !isDocKey(rec.docType)) notFound();
  const key = rec.docType;
  const def = DOC_DEFS[key];
  const tpl = mergeTemplate(key, rec.config);
  const preview = await previewUrl(key, rec.id);
  const input = "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
  const label = "mb-1 block text-xs font-medium text-muted-foreground";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/settings/documents" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Documents
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {rec.name}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{def.label}</span>
            {rec.isDefault && <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary"><Star className="size-3" />Default</span>}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{def.description} This editor controls the real document produced by the CRM.</p>
        </div>
        {!rec.isDefault && <form action={setDefaultDocTemplate.bind(null, rec.id)}><Button variant="outline" type="submit"><Star className="size-4" />Make default</Button></form>}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] p-4 sm:flex-row sm:items-center">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary"><Eye className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">You are editing the live {def.label.toLowerCase()} design</p>
          <p className="text-xs text-muted-foreground">Save to refresh the preview. It uses your latest real record; CRM print and PDF actions use whichever template is marked Default.</p>
        </div>
        {saved === "1" && <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-400"><CheckCircle2 className="size-4" />Saved and refreshed</span>}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[430px_1fr]">
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <p className="mb-2 text-sm font-semibold">Logo</p>
            <div className="mb-3 flex h-16 items-center rounded-lg bg-[#020617] px-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={tpl.logoUrl ?? "/branding/denago-logo-email.png"} alt="Current logo" className="h-10 w-auto object-contain" />
            </div>
            <form action={uploadTemplateLogo.bind(null, rec.id)} className="flex items-center gap-2">
              <input type="file" name="file" accept="image/*" required className="block min-w-0 flex-1 text-xs text-muted-foreground" />
              <Button size="sm" variant="outline" type="submit"><ImageUp className="size-3.5" />Replace</Button>
            </form>
          </div>

          <form action={updateDocTemplate.bind(null, rec.id)} className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm">
            <input type="hidden" name="logoUrl" value={tpl.logoUrl ?? ""} />

            <EditorHeading icon={LayoutTemplate} label="Identity & wording" />
            <div><label className={label}>Template name <span className="font-normal text-muted-foreground/70">(internal)</span></label><input name="name" defaultValue={rec.name} className={input} required /></div>
            <div><label className={label}>Printed document title</label><input name="documentTitle" defaultValue={tpl.documentTitle ?? ""} className={input} placeholder={def.label} /></div>
            <div><label className={label}>Intro line <span className="font-normal text-muted-foreground/70">(under the header)</span></label><input name="intro" defaultValue={tpl.intro ?? ""} className={input} /></div>

            <EditorHeading icon={Palette} label="Appearance" />
            <div>
              <label className={label}>Accent colour</label>
              <div className="flex items-center gap-2">
                <input name="accentColor" type="color" defaultValue={tpl.appearance.accentColor} className="h-10 w-14 cursor-pointer rounded-md border border-input bg-card p-1" />
                <span className="font-mono text-xs uppercase text-muted-foreground">{tpl.appearance.accentColor}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={label}>Header</label><select name="headerStyle" defaultValue={tpl.appearance.headerStyle} className={input}><option value="dark">Dark</option><option value="accent">Accent colour</option><option value="light">Light</option></select></div>
              <div><label className={label}>Spacing</label><select name="density" defaultValue={tpl.appearance.density} className={input}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div>
            </div>
            <div>
              <label className={label}>Typography</label>
              <div className="grid grid-cols-2 gap-2">
                <Choice name="typography" value="modern" checked={tpl.appearance.typography === "modern"} label="Modern" />
                <Choice name="typography" value="classic" checked={tpl.appearance.typography === "classic"} label="Classic" classic />
              </div>
            </div>

            <EditorHeading icon={Type} label="Content & structure" />
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Visible sections</p>
              <div className="grid grid-cols-2 gap-2">
                {def.sections.map((section) => <label key={section.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-[12px] text-foreground/90"><input type="checkbox" name={`section_${section.id}`} defaultChecked={tpl.sections[section.id] !== false} className="size-4 accent-orange-600" />{section.label}</label>)}
              </div>
            </div>
            <div><label className={label}>Editable section heading</label><input name="sectionHeading" defaultValue={tpl.sectionHeading ?? ""} className={input} placeholder={key === "indemnity" ? "Indemnity & waiver" : "Optional heading"} /></div>
            <div>
              <label className={label}>Document text {key === "indemnity" ? "(the waiver itself)" : key === "agreement" ? "(the contract clauses)" : key === "invoice" ? "(banking details)" : "(optional block above signatures)"}</label>
              <textarea name="bodyText" rows={8} defaultValue={tpl.bodyText ?? ""} className={`${input} resize-y leading-6`} />
              <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">Line breaks are preserved. Use one numbered clause or paragraph per line.</p>
            </div>
            {(key === "quote" || key === "invoice") && <div><label className={label}>{key === "quote" ? "Terms & conditions (blank = quote defaults)" : "Payment terms"}</label><textarea name="terms" rows={5} defaultValue={tpl.terms ?? ""} className={`${input} resize-y`} /></div>}
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Signatures</p>
              <select name="sigPosition" defaultValue={tpl.signature.position} className={input}>{SIGNATURE_POSITIONS.map((position) => <option key={position.id} value={position.id}>{position.label}</option>)}</select>
              <label className="mt-2 flex items-center gap-2 text-[13px] text-foreground/90"><input type="checkbox" name="dealerCounterSign" defaultChecked={tpl.signature.dealerCounterSign} className="size-4 accent-orange-600" />Show the Denago signature box</label>
            </div>
            <div><label className={label}>Footer lines <span className="font-normal text-muted-foreground/70">(one per line, maximum four)</span></label><textarea name="footerLines" rows={3} defaultValue={tpl.footerLines.join("\n")} className={input} /></div>
            <Button type="submit" className="w-full">Save &amp; refresh preview</Button>
          </form>
        </div>

        <div className="sticky top-4 rounded-xl border border-border bg-card p-2 shadow-sm">
          {preview ? <iframe src={preview} title="Template preview" className="h-[78vh] w-full rounded-lg bg-white" /> : <p className="p-8 text-center text-sm text-muted-foreground">Nothing to preview yet — create a {def.label.toLowerCase()} source record first.</p>}
        </div>
      </div>
    </div>
  );
}

function EditorHeading({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return <div className="flex items-center gap-2 border-b border-border pb-2 pt-1"><Icon className="size-4 text-primary" /><p className="text-sm font-semibold">{label}</p></div>;
}

function Choice({ name, value, checked, label, classic = false }: { name: string; value: string; checked: boolean; label: string; classic?: boolean }) {
  return <label className={`flex cursor-pointer items-center gap-2 rounded-lg border border-input p-3 text-xs ${classic ? "font-serif" : ""}`}><input type="radio" name={name} value={value} defaultChecked={checked} className="accent-orange-600" /><Type className="size-4" />{label}</label>;
}
