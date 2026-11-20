import "server-only";
import { basePrisma } from "./db";
import { readFile } from "./storage";
import { isModuleEnabled } from "./modules/enabled";
import { senderTeamIds } from "./signatureBannerStore";
import { teamLineFor, type SignatureExtras } from "./signaturePeople";
import type { SignatureDesign } from "./signature";

/*
 * What a sender's signature carries beyond name, title, mobile and email (the Email signatures pack, 2026-11-20): their
 * own extra details, their team's line and their photo. Read only while the pack is on — off, every signature is
 * exactly the automatic one it was before the pack existed.
 */

/** The address of a person's signature photo. Never fetched by recipients: the email carries the bytes (below). */
export const signaturePhotoPath = (userId: string) => `/api/signature-photo/${userId}`;

export async function senderSignatureDetails(
  tenantId: string | null,
  userId: string,
  design: SignatureDesign,
  origin: string,
): Promise<{ extras?: SignatureExtras; teamLine?: string }> {
  if (!tenantId || !(await isModuleEnabled("signatures"))) return {};
  const person = await basePrisma.user.findFirst({
    // A member of this workspace only — the id came from the caller, the workspace names the rows.
    where: { id: userId, memberships: { some: { tenantId } } },
    select: {
      signatureQualifications: true, signatureDirectLine: true, signatureWhatsapp: true, signatureBookingUrl: true,
      signatureHours: true, signaturePhoto: true, avatarRef: true,
    },
  });
  if (!person) return {};
  const teamLine = design.teams?.length ? teamLineFor(design.teams, await senderTeamIds(tenantId, userId)) : "";
  return {
    extras: {
      qualifications: person.signatureQualifications,
      directLine: person.signatureDirectLine,
      whatsapp: person.signatureWhatsapp,
      bookingUrl: person.signatureBookingUrl,
      hours: person.signatureHours,
      photoUrl: person.signaturePhoto && person.avatarRef ? `${origin.replace(/\/$/, "")}${signaturePhotoPath(userId)}` : null,
    },
    teamLine,
  };
}

const PHOTO_MAX_BYTES = 1024 * 1024;
const PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The photo's bytes for the email (lib/emailInlineLogo.ts embeds them, so mail apps that block remote images still show
 * it) — only for a member of THIS workspace who switched their photo on. Null otherwise.
 */
export async function signaturePhotoBytes(
  tenantId: string,
  userId: string,
  /** The editor's live preview, for the person themselves or the owner: the photo before it is switched on. */
  { evenIfOff = false }: { evenIfOff?: boolean } = {},
): Promise<{ content: Buffer; contentType: string } | null> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(userId)) return null;
  const person = await basePrisma.user.findFirst({
    where: { id: userId, ...(evenIfOff ? {} : { signaturePhoto: true }), memberships: { some: { tenantId } } },
    select: { avatarRef: true, avatarMimeType: true },
  });
  if (!person?.avatarRef || !person.avatarMimeType || !PHOTO_TYPES.has(person.avatarMimeType)) return null;
  const content = await readFile(person.avatarRef);
  return content.length <= PHOTO_MAX_BYTES ? { content, contentType: person.avatarMimeType } : null;
}
