import "server-only";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { publishedBuilderTemplateFor } from "@/lib/docbuilder/published";
import { deliveryNoteContext, serviceReportContext } from "@/lib/docbuilder/deliveryServiceContext";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import type { DocumentModel } from "@/lib/doceditor/model";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
import {
  DEFAULT_HANDOVER_ITEMS,
  guidedEntryDetail,
  type HandoverRun,
} from "@/lib/doceditor/handoverChecklist";
import { deliveryNoteRuns } from "@/lib/checklists/deliveryHandover";
import { bindCtx, logoDataUri } from "@/lib/signing/render";
import { embedDocImages } from "@/lib/doceditor/renderGlobals";
import { embedStoredImage } from "@/lib/storedImage";
import { formatDate } from "@/lib/format";
import { includedLines } from "@/lib/pricing";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { isPathEnabled } from "@/lib/modules/registry";

/**
 * The delivery note and service report, printed from the single document editor.
 *
 * SAFE SWITCH: a print page takes this path only when the layout for its type
 * has been PUBLISHED (or Document Studio previews a builder layout with ?tpl=).
 * Until then it keeps rendering its fixed React layout, so seeding or drafting a
 * layout never changes a document anyone prints.
 */
export async function builderLayoutFor(key: "delivery" | "service-report", tplId?: string | null): Promise<DocumentModel | null> {
  let template;
  // A draft is Document Studio's, not the record's: reading the quote or job
  // card is not permission to see an unpublished layout. Without Builder access
  // ?tpl= is ignored and the record prints as everyone else sees it.
  if (tplId && !(await canPreviewBuilderDraft())) tplId = null;
  if (tplId) {
    // ?tpl= from Settings → Documents is a LEGACY template id; only a builder
    // template of this very type is previewed here (as its draft). Anything else
    // stays with the old renderer, which is what asked for it.
    template = await getBuilderTemplate(tplId).catch(() => null);
    if (template?.key !== key) return null;
  } else {
    template = await publishedBuilderTemplateFor(key);
  }
  if (!template) return null;
  const read = readTemplateDocument(template.data, template.name);
  return read.status === "ok" ? read.doc : null;
}

async function canPreviewBuilderDraft(): Promise<boolean> {
  const user = await getCurrentUser();
  return !!user && (await hasAnyPermission(user, "docbuilder.view", "docbuilder.manage"));
}

/** Route handlers run no layout, so they repeat the (print) layout's module guard. */
export async function printPathBlocked(pathname: string): Promise<boolean> {
  const enabled = await getEnabledModuleIds().catch(() => null);
  return !!enabled && !isPathEnabled(pathname, enabled);
}

/**
 * The completed delivery checklist runs this note shows, and the signature.
 * Shared by the fixed layout and the builder layout so the two can never
 * disagree about WHICH runs the customer signed beside.
 */
export async function loadDeliveryEvidence(
  quote: { id: string; tenantId: string | null; deliveryHandoverRunIds: string[]; deliverySignatureRef: string | null },
  requestedRuns: string | undefined,
) {
  const guidedRuns = quote.tenantId
    ? await prisma.checklistRun.findMany({
        where: {
          tenantId: quote.tenantId,
          hostType: "quote.delivery",
          hostId: quote.id,
          completedAt: { not: null },
        },
        orderBy: { completedAt: "desc" },
        select: {
          id: true,
          templateId: true,
          completedAt: true,
          template: { select: { name: true, sortOrder: true } },
          entries: {
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              labelSnapshot: true,
              captureSnapshot: true,
              status: true,
              note: true,
              value: true,
              skipReason: true,
              photos: { select: { id: true, url: true } },
            },
          },
        },
      })
    : [];

  // A delivery checklist is repeatable by design, but the delivery note should
  // show the run the customer is actually signing, not every historical retry.
  //
  // ONCE SIGNED, THAT IS DECIDED AND THIS MUST NOT RE-DECIDE IT. Choosing the
  // newest completed run per template on every render meant a checklist re-run
  // AFTER handover silently replaced the evidence beside a signature the customer
  // had already given — the document changed after it was signed. The per-entry
  // snapshots froze the template's wording; nothing froze WHICH RUN.
  //
  // completeGuidedDelivery now records the ids at the moment of signing, in the
  // same write that records the delivery. Where they exist they are the whole
  // answer, and a later run cannot appear on this note however new it is.
  /*
   * BEFORE SIGNING, THE REVIEWER SAYS WHICH RUNS. After it, the record does.
   *
   * `deliveryHandoverRunIds` is written at the moment of signing and is the
   * whole answer once it exists — a later run cannot appear on a signed note.
   * But during REVIEW there is nothing written yet, and picking "the newest
   * completed run per template" here while the completion action picked it again
   * at submission is what let the customer read one note and sign beside
   * another. The screen now chooses once and passes the ids to both.
   *
   * Only ids that are already among this quote's completed runs survive the
   * intersection below, so the parameter cannot introduce anything; and a signed
   * note ignores it entirely.
   */
  const previewRunIds = (requestedRuns ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const noteRunIds = quote.deliveryHandoverRunIds.length > 0
    ? quote.deliveryHandoverRunIds
    : previewRunIds.filter((id) => guidedRuns.some((run) => run.id === id));
  const guidedRunsForNote = deliveryNoteRuns(guidedRuns, noteRunIds);

  const signatureDoc = quote.deliverySignatureRef
    ? await prisma.document.findFirst({
        where: { quoteId: quote.id, tag: "delivery-signature", deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })
    : null;

  return { guidedRunsForNote, signatureDoc };
}

export async function renderDeliveryNoteHtml(opts: {
  quoteId: string;
  doc: DocumentModel;
  requestedRuns?: string;
  toolbarHtml?: string;
}): Promise<string | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: opts.quoteId },
    select: {
      id: true,
      tenantId: true,
      number: true,
      items: true,
      deliveredAt: true,
      deliveryScheduledFor: true,
      deliveredByName: true,
      deliveryChecklist: true,
      deliveryHandoverRunIds: true,
      deliverySignatureRef: true,
    },
  });
  if (!quote) return null;
  const { guidedRunsForNote, signatureDoc } = await loadDeliveryEvidence(quote, opts.requestedRuns);
  const base = await bindCtx(quote.id, null);
  if (!base) return null;

  // ponytail: every checklist photo is embedded inline, which is what makes the
  // page self-contained for Save as PDF; thumbnail server-side if notes get heavy.
  const runs: HandoverRun[] = guidedRunsForNote.length
    ? await Promise.all(
        guidedRunsForNote.map(async (run) => ({
          name: run.template.name,
          completed: run.completedAt ? formatDate(run.completedAt, base.regional) : null,
          entries: await Promise.all(
            run.entries.map(async (entry) => ({
              label: entry.labelSnapshot,
              mark: entry.status === "done" ? "done" as const : entry.status === "skipped" || entry.status === "na" ? "skipped" as const : "open" as const,
              detail: guidedEntryDetail(entry),
              photos: (await Promise.all(entry.photos.map((p) => embedStoredImage(p.url, quote.tenantId)))).filter((s): s is string => !!s),
            })),
          ),
        })),
      )
    : [legacyRun(quote.deliveryChecklist)];

  const signature = signatureDoc ? await embedStoredImage(quote.deliverySignatureRef, quote.tenantId) : null;
  const ctx = deliveryNoteContext(base, {
    quoteNumber: quote.number,
    deliveredAt: quote.deliveredAt,
    deliveryScheduledFor: quote.deliveryScheduledFor,
    deliveredByName: quote.deliveredByName,
    lineCount: includedLines(quote.items).length,
    handover: { runs, signature, signedOn: signature && quote.deliveredAt ? formatDate(quote.deliveredAt, base.regional) : null },
  });
  // Uploaded image blocks are private files: embedded, owner-checked against the
  // record's workspace. The workspace logo arrives on ctx.logo from bindCtx.
  const doc = await embedDocImages(opts.doc, quote.tenantId ?? undefined);
  return renderDocumentHtml(doc, ctx, logoDataUri(), { hideOverlays: true, toolbarHtml: opts.toolbarHtml });
}

/** The pre-guided proof-of-delivery ticks, or the default list unticked — as the fixed layout prints. */
function legacyRun(checklist: unknown): HandoverRun {
  const ticked = Object.entries((checklist ?? {}) as Record<string, boolean>);
  const entries = ticked.length ? ticked : DEFAULT_HANDOVER_ITEMS.map((label) => [label, false] as const);
  return {
    name: null,
    completed: null,
    entries: entries.map(([label, done]) => ({ label: String(label), mark: done ? "done" : "open", detail: null, photos: [] })),
  };
}

export async function renderServiceReportHtml(opts: {
  jobCardId: string;
  doc: DocumentModel;
  toolbarHtml?: string;
}): Promise<string | null> {
  const jobCard = await prisma.jobCard.findUnique({
    where: { id: opts.jobCardId },
    select: {
      id: true,
      tenantId: true,
      number: true,
      completedAt: true,
      vehicle: { select: { vin: true } },
      serviceRecord: { include: { performedBy: { select: { name: true } } } },
    },
  });
  if (!jobCard) return null;
  const sr = jobCard.serviceRecord;
  const base = await bindCtx(null, jobCard.id);
  if (!base) return null;
  const ctx = serviceReportContext(base, {
    jobCardNumber: jobCard.number,
    serviceDate: sr?.serviceDate ?? null,
    completedAt: jobCard.completedAt,
    technician: sr?.performedBy?.name ?? null,
    km: sr?.km ?? null,
    vin: jobCard.vehicle.vin,
    summary: sr?.summary ?? null,
    details: sr?.details ?? null,
    nextDueDate: sr?.nextDueDate ?? null,
    nextDueKm: sr?.nextDueKm ?? null,
  });
  const doc = await embedDocImages(opts.doc, jobCard.tenantId ?? undefined);
  return renderDocumentHtml(doc, ctx, logoDataUri(), { hideOverlays: true, toolbarHtml: opts.toolbarHtml });
}

export function printHtmlResponse(html: string | null): Response {
  if (!html) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Customer details and signatures — never cached by a proxy.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
