/**
 * Uploading a document straight from the browser to storage — the shared rules.
 *
 * WHY: documents used to be sent through a Server Action, and Vercel refuses any
 * function request body over 4.5 MB before the action runs, whatever the app's
 * own limit said. A scanned contract or a PDF brochure simply failed. Photos
 * already avoided this by uploading directly to Blob storage and then
 * registering the stored file; documents now do the same.
 *
 * Pure — imported by the browser uploader, the token route and the register
 * action — so the PATH, which is also the permission (see `documentUploadPrefix`),
 * exists in exactly one place.
 */
import type { UploadTarget } from "./documentFolders";

/**
 * Largest document accepted. Well past anything the old path could take: the
 * upload goes to storage directly, and downloads now stream (see
 * /api/files/[id]), so neither direction is bounded by the function body limit.
 */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

/** One path segment naming what a file is filed on: `company`, `quote-<id>`… */
export function documentTargetKey(target: UploadTarget): string {
  if (target.kind === "company") return "company";
  const kind = { contactId: "contact", vehicleId: "vehicle", jobCardId: "jobcard", quoteId: "quote" }[target.field];
  return `${kind}-${target.id}`;
}

/**
 * `uploads/<tenantId>/document/<target>/` — where a document for this target
 * must be stored.
 *
 * THE PATH IS THE PERMISSION, exactly as for photos. The token route signs an
 * upload only for this prefix, after checking the caller may file on this
 * target in this workspace; the register action refuses a stored file outside
 * it. So a file can never be registered against a record other than the one it
 * was authorised for, and never across workspaces. The shape also matches the
 * orphan sweep's (`uploads/<tenant>/<kind>/<record>/…`), so an upload that is
 * never registered is cleaned up after a day.
 */
export function documentUploadPrefix(tenantId: string, target: UploadTarget): string {
  return `uploads/${tenantId}/document/${documentTargetKey(target)}/`;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELDS = ["contactId", "vehicleId", "jobCardId", "quoteId"] as const;

/** The client's claimed target, validated. Throws on anything malformed. */
export function parseDocumentTarget(raw: unknown): UploadTarget {
  const value = (typeof raw === "string" ? JSON.parse(raw || "{}") : raw) as Record<string, unknown> | null;
  if (value?.kind === "company") return { kind: "company" };
  if (
    value?.kind === "record" &&
    (FIELDS as readonly string[]).includes(String(value.field)) &&
    typeof value.id === "string" &&
    ID.test(value.id)
  ) {
    return { kind: "record", field: value.field as (typeof FIELDS)[number], id: value.id };
  }
  throw new Error("Invalid document upload target.");
}

/**
 * The name to show for an uploaded file. The browser supplies it, so it is
 * cleaned: no directory part, no control characters, a sensible length, and
 * never empty.
 */
export function cleanDocumentFileName(name: unknown): string {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return base || "Document";
}
