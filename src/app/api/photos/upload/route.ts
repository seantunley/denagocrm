import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { actingTenantId } from "@/lib/actingTenant";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { MAX_PHOTO_BYTES } from "@/lib/photoBudget";
import { requireJobCardAccess, requireQuoteAccess } from "@/lib/permissions";
import { requireChecklistHostAccess } from "@/lib/checklists/hostRecords";

export const runtime = "nodejs";

/**
 * `checklist` addresses a ChecklistEntry, and its photos are bound to that entry
 * rather than to the record the checklist is about. That is deliberate: the blob
 * prefix built below becomes `uploads/<tenant>/checklist/<entryId>/`, so a photo
 * captured for "Serial number" can never be filed against "Charger" even by a
 * caller writing its own upload path. The entry is the finest-grained thing the
 * evidence belongs to, so it is what the path names.
 */
const PHOTO_KINDS = ["delivery", "jobcard", "jobcard-checkout", "inspection", "checklist"] as const;

type PhotoTarget = {
  kind: (typeof PHOTO_KINDS)[number];
  recordId: string;
  jobCardId?: string;
};

function parseTarget(raw: string | null | undefined): PhotoTarget {
  const value = JSON.parse(raw ?? "{}") as Partial<PhotoTarget>;
  if (!(PHOTO_KINDS as readonly string[]).includes(String(value.kind)) || !value.recordId) {
    throw new Error("Invalid photo upload target.");
  }
  return { kind: value.kind as PhotoTarget["kind"], recordId: String(value.recordId), jobCardId: value.jobCardId ? String(value.jobCardId) : undefined };
}

export async function POST(request: Request) {
  let tenantId: string | null = null;
  /*
   * A plain string rather than the parsed target.
   *
   * `target` is only assigned inside the onBeforeGenerateToken closure, and
   * TypeScript's control-flow analysis does not follow that: at the catch block
   * it still believes the variable is null, narrows it to `never`, and rejects
   * `target?.kind` — so the failure log could not name what failed, which is the
   * one thing this route's logging exists to do. Building the message eagerly
   * sidesteps the narrowing entirely.
   */
  let failureContext = "kind=unknown record=unknown";
  try {
    tenantId = await actingTenantId();
    const body = (await request.json()) as HandleUploadBody;
    const response = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const target = parseTarget(clientPayload);
        failureContext = `kind=${target.kind} record=${target.recordId}`;
        if (target.kind === "delivery") {
          await requireQuoteAccess(target.recordId, "deliveries.manage");
          const quote = await basePrisma.quote.findFirst({
            where: { id: target.recordId, tenantId },
            select: { id: true, tenantId: true },
          });
          if (!quote?.tenantId) throw new Error("This quote is not available in the active workspace.");
        } else if (target.kind === "inspection") {
          if (!target.jobCardId) throw new Error("Missing inspection job card.");
          await requireJobCardAccess(target.jobCardId, "jobcards.manage");
          const item = await basePrisma.jobCardInspectionItem.findFirst({
            where: { id: target.recordId, jobCardId: target.jobCardId, tenantId },
            select: { id: true },
          });
          if (!item) throw new Error("This inspection item is not available in the active workspace.");
        } else if (target.kind === "checklist") {
          /*
           * The entry must ALREADY EXIST server-side before a photo may be
           * uploaded against it, which is why the capture screen syncs the run
           * before it drains its photo queue.
           *
           * That ordering is not an inconvenience to work around — it is what
           * makes this check possible at all. Authorising against the entry lets
           * us resolve the run, the host record behind it, and the permission
           * that host demands, so an upload token is only ever issued to somebody
           * who could have attached evidence to that record by hand.
           */
          if (!tenantId) throw new Error("No active workspace.");
          const entry = await basePrisma.checklistEntry.findFirst({
            where: { id: target.recordId, tenantId },
            select: { id: true, run: { select: { hostType: true, hostId: true } } },
          });
          if (!entry?.run) throw new Error("This checklist step is not available in the active workspace.");
          await requireChecklistHostAccess(entry.run.hostType, entry.run.hostId, tenantId);
        } else {
          await requireJobCardAccess(target.recordId, "jobcards.manage");
          const jobCard = await basePrisma.jobCard.findFirst({
            where: { id: target.recordId, tenantId },
            select: { id: true, tenantId: true },
          });
          if (!jobCard?.tenantId) throw new Error("This job card is not available in the active workspace.");
        }

        const prefix = `uploads/${tenantId}/${target.kind}/${target.recordId}/`;
        if (!pathname.startsWith(prefix)) {
          throw new Error("The upload path does not belong to this record.");
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
          maximumSizeInBytes: MAX_PHOTO_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ tenantId, ...target }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const ownership = JSON.parse(tokenPayload ?? "{}") as Partial<PhotoTarget> & { tenantId?: string };
        if (!ownership.tenantId || !ownership.recordId || !ownership.kind) {
          await logError("photo-upload-completed", new Error("Missing upload ownership"), blob.pathname, {
            tenantId: ownership.tenantId ?? null,
            alert: false,
          });
        }
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    await logError(
      "photo-upload-token",
      error,
      failureContext,
      { tenantId, alert: false },
    );
    return NextResponse.json(
      { error: "The photo upload could not be authorised. See Settings → System Log." },
      { status: 400 },
    );
  }
}
