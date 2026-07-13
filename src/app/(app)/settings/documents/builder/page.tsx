import Link from "next/link";
import { ArrowLeft, Plus, Star, Trash2, PenLine, FileDown, Sparkles } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { ensureBuilderSeeded, listBuilderTemplates } from "@/lib/docbuilder/store";
import { deleteBuilderTemplate, setDefaultBuilderTemplate } from "@/app/actions/docbuilder";
import { createDocEditorTemplate, createStandardQuoteTemplate, generateDocEditorDocument } from "@/app/actions/doceditor";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const DOC_KEYS = ["proposal", "quote", "invoice", "agreement", "delivery", "indemnity", "jobcard", "service-report", "warranty-claim", "custom"];

// Merge fields available in any text block (typed as {{token}}).
const TOKENS = [
  "customer.name", "customer.phone", "customer.email", "customer.address",
  "quote.number", "quote.date", "quote.validUntil", "quote.subtotal", "quote.vat", "quote.total",
  "vehicle", "preparedBy",
];

export default async function BuilderIndexPage() {
  await requireOwner();
  await ensureBuilderSeeded();
  const [templates, quotes] = await Promise.all([
    listBuilderTemplates(),
    prisma.quote.findMany({
      where: { supersededAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { contact: true },
    }),
  ]);

  const input =
    "h-9 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings/documents" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Documents
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Document Builder</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Drag-and-drop blocks into a document that flows across as many pages as it needs, then
          export a professional PDF. Your documents — full control.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">New document</p>
          <form action={createStandardQuoteTemplate}>
            <Button type="submit" variant="outline" size="sm">
              <Sparkles className="size-3.5" />
              Start from “Standard” quote
            </Button>
          </form>
        </div>
        <form action={createDocEditorTemplate} className="flex flex-wrap items-center gap-2">
          <input name="name" required placeholder="Document name…" className={`${input} flex-1 min-w-48`} />
          <select name="key" defaultValue="proposal" className={input}>
            {DOC_KEYS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <Button type="submit">
            <Plus className="size-4" />
            Create &amp; edit
          </Button>
        </form>
      </div>

      {/* Generate a real document from a template + a record, filed in the repository */}
      <div className="rounded-xl border border-primary/25 bg-primary/[0.05] p-4 shadow-sm">
        <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="size-4 text-primary" />
          Generate a document
        </p>
        <p className="mb-3 text-xs text-muted-foreground">
          Pick a template and a quote — merge fields and line items fill from the quote, and the PDF
          is filed in your Document repository (and on the quote).
        </p>
        <form action={generateDocEditorDocument} className="flex flex-wrap items-end gap-2">
          <select name="templateId" required className={input} defaultValue="">
            <option value="" disabled>Template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.key})</option>
            ))}
          </select>
          <select name="quoteId" className={input} defaultValue="">
            <option value="">No record (placeholders)</option>
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>Q-{q.number}{q.contact ? ` — ${contactName(q.contact)}` : ""}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" name="sign" className="size-3.5" /> Seal it
          </label>
          <Button type="submit">
            <FileDown className="size-4" />
            Generate &amp; file
          </Button>
        </form>
      </div>

      {/* Merge-field reference */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-foreground">Merge fields</p>
        <p className="mb-2 text-xs text-muted-foreground">
          Type any of these into a text block — they fill from the linked record at generate time.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {TOKENS.map((t) => (
            <code key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">{`{{${t}}}`}</code>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-foreground">Your documents</p>
        {templates.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground/70">None yet — create one above.</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {templates.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2">
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  <Link href={`/doc-editor/${t.id}`} className="hover:text-primary">{t.name}</Link>
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t.key}</span>
                  {t.isDefault && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                      <Star className="size-2.5" />Default
                    </span>
                  )}
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">edited {formatDate(t.updatedAt)}</span>
                </p>
                <Button asChild variant="outline" size="sm" title="Preview PDF">
                  <a href={`/api/pdf/doc-editor/${t.id}`} target="_blank" rel="noreferrer">
                    <FileDown className="size-3.5" />
                    PDF
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm" title="Open the editor">
                  <Link href={`/doc-editor/${t.id}`}>
                    <PenLine className="size-3.5" />
                    Edit
                  </Link>
                </Button>
                {!t.isDefault && (
                  <form action={setDefaultBuilderTemplate.bind(null, t.id)}>
                    <Button variant="ghost" size="sm" title="Make default for this type"><Star className="size-3.5" /></Button>
                  </form>
                )}
                <form action={deleteBuilderTemplate.bind(null, t.id)}>
                  <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300" title="Delete"><Trash2 className="size-3.5" /></Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
