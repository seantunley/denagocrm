"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { LEGAL_LINE_KEY, cleanLegalLine } from "@/lib/emailLegalLine";
import { putSetting } from "@/lib/settings";
import { savePublicAsset } from "@/lib/storage";
import { listActingTenantStaff, listActingTenantTeams } from "@/lib/tenantActor";
import {
  BANNER_ALT_MAX,
  BANNER_MAX_HEIGHT,
  BANNER_MAX_WIDTH,
  BANNER_MIN_WIDTH,
  BANNER_NAME_MAX,
  bannerDay,
  bannerDisplaySize,
  bannerPosition,
  isBannerLink,
  nextBannerLink,
} from "@/lib/signatureBanners";

const PAGE = "/settings/signature-banners";
/**
 * The banner travels INSIDE every email that carries it, so its size is every
 * email's size. Signature tools ask for well under 100 KB; this leaves room for
 * a photograph at twice its shown size and no more.
 */
const BANNER_IMAGE_MAX_BYTES = 300 * 1024;
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };

async function workspace() {
  const user = await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
  return { user, tenantId };
}

/**
 * Create a signature banner, or change one (`id` on the form).
 *
 * Owner only, like the signature design itself: this decides what marketing
 * every email the team writes carries. A NEW banner is always created switched
 * off — putting it in front of customers is its own deliberate click
 * (setMarketingBannerActive), never a side effect of saving a draft.
 *
 * "Marketing banner" in code, because actions/emails.ts already has a
 * saveSignatureBanner: the logo panel inside the signature card.
 */
export async function saveMarketingBanner(formData: FormData): Promise<ActionResult> {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const { user, tenantId } = await workspace();
      const id = String(formData.get("id") ?? "").trim() || null;
      const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ").slice(0, BANNER_NAME_MAX);
      const linkUrl = String(formData.get("linkUrl") ?? "").trim();
      const altText = String(formData.get("altText") ?? "").trim().replace(/\s+/g, " ").slice(0, BANNER_ALT_MAX);
      const startsOn = String(formData.get("startsOn") ?? "").trim();
      const endsOn = String(formData.get("endsOn") ?? "").trim();
      const senderIds = [...new Set(formData.getAll("senderIds").map(String).filter(Boolean))];
      const teamIds = [...new Set(formData.getAll("teamIds").map(String).filter(Boolean))];
      const position = bannerPosition(String(formData.get("position") ?? ""));
      const onQuoteEmails = formData.get("onQuoteEmails") === "on";

      if (!name) refuse("Give the banner a name, so you can tell it from the others.");
      if (!isBannerLink(linkUrl)) refuse("The link has to be a full https address, like https://www.example.co.za/special.");
      const startsAt = startsOn ? bannerDay(startsOn, "start") : null;
      const endsAt = endsOn ? bannerDay(endsOn, "end") : null;
      if ((startsOn && !startsAt) || (endsOn && !endsAt)) refuse("One of the dates isn't a date.");
      if (startsAt && endsAt && endsAt <= startsAt) refuse("The last day is before the first day.");

      if (senderIds.length > 0) {
        const staff = new Set((await listActingTenantStaff()).map((person) => person.id));
        if (senderIds.some((senderId) => !staff.has(senderId))) {
          refuse("One of the chosen people is not an active member of this workspace. Refresh and try again.");
        }
      }
      if (teamIds.length > 0) {
        const teams = new Set((await listActingTenantTeams()).map((team) => team.id));
        if (teamIds.some((teamId) => !teams.has(teamId))) refuse("One of the chosen teams no longer exists. Refresh and try again.");
      }

      // The image: required for a new banner, optional when changing one.
      let image: { imageUrl: string; width: number; height: number } | null = null;
      const file = formData.get("image");
      if (file instanceof File && file.size > 0) {
        const ext = IMAGE_TYPES[file.type];
        if (!ext) refuse("The banner has to be a PNG, JPG or GIF image.");
        if (file.size > BANNER_IMAGE_MAX_BYTES) refuse("The image is over 300 KB. It travels inside every email, so save it smaller.");
        // Measured in the owner's browser from the file itself; bounded here, where it is trusted.
        const size = bannerDisplaySize(Number(formData.get("naturalWidth")), Number(formData.get("naturalHeight")));
        if (!size) {
          refuse(`The image has to be at least ${BANNER_MIN_WIDTH}px wide, and wide rather than tall — at most ${BANNER_MAX_HEIGHT}px high when shown ${BANNER_MAX_WIDTH}px wide.`);
        }
        const imageUrl = await savePublicAsset(Buffer.from(await file.arrayBuffer()), `signature-marketing.${ext}`, file.type, tenantId);
        // Without a public store the file lands on local disk with no web address a mail app could load.
        if (!/^https:\/\//i.test(imageUrl)) refuse("Images can't be stored publicly here — file storage isn't set up.");
        image = { imageUrl, ...size };
      }

      const data = { name, linkUrl, altText, startsAt, endsAt, senderIds, teamIds, position, onQuoteEmails };
      /*
       * A DESTINATION IS NEVER EDITED IN PLACE. Every email already sent carries
       * a link token, and a customer may click it weeks later. So a link row
       * (SignatureBannerLink) freezes token → address, and changing the address
       * makes a NEW token for emails sent from now on; the old token keeps
       * opening the page it was sent with. The link row is written before the
       * banner points at it, so a banner never names a token that leads nowhere.
       */
      const newToken = () => randomBytes(24).toString("base64url");
      if (id) {
        const existing = await prisma.signatureBanner.findFirst({ where: { id, tenantId }, select: { linkUrl: true, token: true } });
        if (!existing) refuse("That banner no longer exists. Refresh and try again.");
        const hasLinkRow = Boolean(await prisma.signatureBannerLink.findFirst({ where: { tenantId, token: existing.token }, select: { id: true } }));
        const { token, createLink } = nextBannerLink({ current: existing, linkUrl, hasLinkRow, newToken });
        if (createLink) await prisma.signatureBannerLink.create({ data: { tenantId, bannerId: id, token, linkUrl } });
        const changed = await prisma.signatureBanner.updateMany({ where: { id, tenantId }, data: { ...data, token, ...(image ?? {}) } });
        if (changed.count !== 1) refuse("That banner no longer exists. Refresh and try again.");
      } else {
        if (!image) refuse("Choose the banner image.");
        const token = newToken();
        const created = await prisma.signatureBanner.create({ data: { tenantId, ...data, ...image, active: false, token }, select: { id: true } });
        await prisma.signatureBannerLink.create({ data: { tenantId, bannerId: created.id, token, linkUrl } });
      }
      await logAudit({
        action: id ? "signature_banner.updated" : "signature_banner.created",
        summary: `${id ? "Changed" : "Added"} the email signature banner “${name}”${endsOn ? `, ending ${endsOn}` : ""}`,
        user,
      });
      revalidatePath(PAGE);
    }),
  );
}

/**
 * The workspace's legal line (lib/emailLegalLine.ts): one sentence at the foot
 * of every email the CRM sends. Owner only. Blank removes it.
 */
export async function saveEmailLegalLine(formData: FormData): Promise<ActionResult> {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const { user } = await workspace();
      const line = cleanLegalLine(String(formData.get("legalLine") ?? ""));
      await putSetting(LEGAL_LINE_KEY, line);
      await logAudit({
        action: "settings.email_legal_line.saved",
        summary: line ? "Set the legal line shown at the foot of every email" : "Removed the legal line from the foot of every email",
        user,
      });
      revalidatePath(PAGE);
    }),
  );
}

/** Switch a banner on (it shows on emails from its start date) or off (it stops at once). */
export async function setMarketingBannerActive(id: string, active: boolean): Promise<ActionResult> {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const { user, tenantId } = await workspace();
      const banner = await prisma.signatureBanner.findFirst({ where: { id: String(id), tenantId }, select: { id: true, name: true, endsAt: true, token: true, linkUrl: true } });
      if (!banner) refuse("That banner no longer exists. Refresh and try again.");
      if (active && banner.endsAt && banner.endsAt <= new Date()) refuse("This banner's last day has passed. Give it a new end date first.");
      // A banner goes in front of customers only with a link that leads somewhere:
      // if its link row is missing (a save that failed half-way), make it now.
      if (active && !(await prisma.signatureBannerLink.findFirst({ where: { tenantId, token: banner.token }, select: { id: true } }))) {
        await prisma.signatureBannerLink.create({ data: { tenantId, bannerId: banner.id, token: banner.token, linkUrl: banner.linkUrl } });
      }
      await prisma.signatureBanner.updateMany({ where: { id: banner.id, tenantId }, data: { active: Boolean(active) } });
      await logAudit({
        action: active ? "signature_banner.switched_on" : "signature_banner.switched_off",
        summary: `Switched the email signature banner “${banner.name}” ${active ? "on" : "off"}`,
        user,
      });
      revalidatePath(PAGE);
    }),
  );
}
