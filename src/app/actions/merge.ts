"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { requireContactAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";
import { asActionResult, refuse } from "@/lib/actionResult";

// Text profile fields the winner backfills from a loser only when it has none.
const PROFILE_FIELDS = ["email", "phone", "whatsapp", "company", "address", "suburb", "city", "province", "postalCode", "notes"] as const;
// Unique channel identities — must live on exactly one contact (or nowhere).
const IDENTITY_FIELDS = ["messengerPsid", "instagramId", "referralCode"] as const;
// Portal-preference booleans — merged conservatively (a disabled flag / opt-out
// on EITHER side must stay off, so AND them; POPIA: never re-enable marketing).
const PREF_FLAGS = ["serviceReminders", "portalNotifications", "marketingEmail", "emailServiceUpdates", "smsServiceUpdates", "emailMarketing"] as const;

/**
 * Merges duplicate contacts into one. Every linked record moves to the kept
 * contact; duplicates are soft-deleted. The caller must have merge permission
 * and access to every record participating in the merge.
 */
export async function mergeContacts(keepId: string, otherIdsCsv: string, formData?: FormData) {
  return asActionResult(async () => {
    const user = await requireContactAccess(keepId, "contacts.merge");
    const otherIds = otherIdsCsv.split(",").filter((id) => id && id !== keepId);
    if (otherIds.length === 0) refuse("There's nothing to merge into this contact.");
    for (const id of otherIds) await requireContactAccess(id, "contacts.merge");
    const reason = String(formData?.get("reason") ?? "").trim() || "Duplicate contact";
    const moved: Record<string, number> = {};

    const keep = await prisma.contact.findUniqueOrThrow({ where: { id: keepId } });
    const others = await prisma.contact.findMany({
      where: { id: { in: otherIds } },
      include: { tags: true },
    });

    for (const other of others) {
      // The ENTIRE merge for this duplicate — every related record, tags, the
      // backfill, identity moves and the soft-delete — runs in ONE transaction so
      // a failure can't leave a half-merged contact. The winner is locked FOR
      // UPDATE and RELOADED inside the transaction: when merging several
      // duplicates, each backfill is computed against the winner's CURRENT state,
      // so a later duplicate can't overwrite data an earlier one just recovered.
      await basePrisma.$transaction(async (tx) => {
        // Lock BOTH the winner and this loser FOR UPDATE, in stable sorted-ID order
        // (deadlock-safe), and RELOAD both live inside the transaction. Previously
        // only the winner was locked, so two concurrent merges of the SAME loser
        // into different winners could split the loser's relations between them.
        const [firstId, secondId] = [keepId, other.id].sort();
        await tx.$executeRaw`SELECT id FROM "Contact" WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;
        const winner = await tx.contact.findFirst({ where: { id: keepId, deletedAt: null } });
        if (!winner) refuse("The contact being kept no longer exists.");
        // Reload the loser live (with tags). If it's already been merged/deleted by
        // a concurrent merge, skip it rather than acting on the stale pre-loop copy.
        const loser = await tx.contact.findFirst({ where: { id: other.id, deletedAt: null }, include: { tags: true } });
        if (!loser) return;

        // Counts what moved, per table, for the audit line.
        const move = async (
          p: { updateMany: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> },
          field: string,
          label = field,
        ) => {
          const { count } = await p.updateMany({ where: { [field]: loser.id }, data: { [field]: keepId } });
          if (count) moved[label] = (moved[label] ?? 0) + count;
        };

        // Plain contactId reassignments. EVERY model with a contact column belongs
        // here (tests/contactMergeComplete.test.ts checks the schema against this
        // list) — test drives, journeys, marketing attribution, survey follow-ups
        // and queued bot messages were left on the deleted duplicate.
        await move(tx.lead, "contactId", "leads");
        await move(tx.vehicle, "contactId", "vehicles");
        await move(tx.jobCard, "contactId", "job cards");
        await move(tx.quote, "contactId", "quotes");
        await move(tx.communication, "contactId", "messages");
        await move(tx.activity, "contactId", "activities");
        await move(tx.document, "contactId", "documents");
        await move(tx.auditLog, "contactId", "history");
        await move(tx.consentRecord, "contactId", "consent records");
        await move(tx.campaignRecipient, "contactId", "campaign sends");
        await move(tx.researchNote, "contactId", "research");
        await move(tx.conversation, "contactId", "conversations");
        await move(tx.customerCase, "contactId", "cases");
        await move(tx.customerCaseMessage, "contactId", "case messages");
        await move(tx.portalNotification, "contactId", "portal notifications");
        await move(tx.portalProfileChangeRequest, "contactId", "profile requests");
        await move(tx.portalUpload, "contactId", "portal uploads");
        await move(tx.fleet, "contactId", "fleets");
        await move(tx.warrantyClaim, "contactId", "warranty claims");
        await move(tx.surveyResponse, "contactId", "survey responses");
        await move(tx.signatureRequest, "contactId", "signing requests");
        await move(tx.docInstance, "contactId", "documents");
        await move(tx.testDriveBooking, "contactId", "test drives");
        await move(tx.journeyRun, "contactId", "journeys");
        await move(tx.marketingTouch, "contactId", "marketing touches");
        await move(tx.campaignConversion, "contactId", "conversions");
        await move(tx.marketingCampaignEvent, "contactId", "campaign events");
        await move(tx.surveyFollowUp, "contactId", "survey follow-ups");
        await move(tx.botFlowOutbox, "contactId", "queued bot messages");

        // Referral has two contact links. Move both, then drop any self-referral
        // the merge created (referrer === referred → a customer referring itself,
        // which would hand them undue referral credit).
        await move(tx.referral, "referrerId", "referrals");
        await move(tx.referral, "contactId", "referrals");
        await tx.referral.deleteMany({ where: { referrerId: keepId, contactId: keepId } });

        // Portal access grants have partial-unique indexes on
        // (viewerContactId, grantedContactId) and (viewerContactId, fleetId).
        // Blindly moving both ends could self-grant (winner granting itself) or
        // collide with a grant the winner already holds, failing the transaction.
        await mergePortalGrants(tx, keepId, loser.id);

        // Custom-field values key on recordId with @@unique([defId, recordId]) —
        // move only the loser's values whose def the winner has no value for.
        const loserVals = await tx.customFieldValue.findMany({
          where: { recordId: loser.id, def: { entity: "contact" } },
          select: { id: true, defId: true },
        });
        if (loserVals.length > 0) {
          const winnerVals = await tx.customFieldValue.findMany({
            where: { recordId: keepId, def: { entity: "contact" } },
            select: { defId: true },
          });
          const winnerDefs = new Set(winnerVals.map((v) => v.defId));
          const moveIds = loserVals.filter((v) => !winnerDefs.has(v.defId)).map((v) => v.id);
          if (moveIds.length > 0) {
            await tx.customFieldValue.updateMany({ where: { id: { in: moveIds } }, data: { recordId: keepId } });
          }
        }

        // Portal preferences. PK IS contactId. If the winner has none, move the
        // loser's row. If both exist, merge conservatively (AND) so a disabled flag
        // or marketing opt-out on either side can never be replaced by a more
        // permissive winner preference.
        const loserPref = await tx.portalPreference.findUnique({ where: { contactId: loser.id } });
        if (loserPref) {
          const winnerPref = await tx.portalPreference.findUnique({ where: { contactId: keepId } });
          if (!winnerPref) {
            await tx.portalPreference.update({ where: { contactId: loser.id }, data: { contactId: keepId } });
          } else {
            const merged: Record<string, boolean> = {};
            for (const flag of PREF_FLAGS) merged[flag] = Boolean(winnerPref[flag]) && Boolean(loserPref[flag]);
            await tx.portalPreference.update({ where: { contactId: keepId }, data: merged as Prisma.PortalPreferenceUpdateInput });
            await tx.portalPreference.delete({ where: { contactId: loser.id } });
          }
        }

        if (loser.tags.length > 0) {
          await tx.contact.update({
            where: { id: keepId },
            data: { tags: { connect: loser.tags.map((tag) => ({ id: tag.id })) } },
          });
        }

        // Unique channel identities must end on the winner (or nowhere). A
        // soft-deleted loser still occupies the unique index, so its identities are
        // ALWAYS cleared — otherwise Messenger / Instagram / referral lookups keep
        // resolving the dead contact, and the value can't move to the winner. Null
        // them on the loser FIRST (releasing the index), then hand each to the
        // winner only where the winner has none (conflicting values stay with the
        // winner and are simply dropped from the loser).
        const loserIdentityNull: Record<string, null> = {};
        const winnerData: Record<string, unknown> = {};
        for (const field of IDENTITY_FIELDS) {
          if (!loser[field]) continue;
          loserIdentityNull[field] = null;
          if (!winner[field]) winnerData[field] = loser[field];
        }
        if (Object.keys(loserIdentityNull).length > 0) {
          await tx.contact.update({ where: { id: loser.id }, data: loserIdentityNull as Prisma.ContactUpdateInput });
        }

        // Backfill blank winner profile fields from the (reloaded) winner's state.
        for (const field of PROFILE_FIELDS) {
          if (!winner[field] && loser[field]) winnerData[field] = loser[field];
        }
        // marketingOptOut is preserved, never cleared: opting out on either side
        // keeps the merged customer opted out (POPIA).
        if (loser.marketingOptOut && !winner.marketingOptOut) winnerData.marketingOptOut = true;

        if (Object.keys(winnerData).length > 0) {
          await tx.contact.update({ where: { id: keepId }, data: winnerData as Prisma.ContactUpdateInput });
        }

        await tx.contact.update({
          where: { id: loser.id },
          data: {
            deletedAt: new Date(),
            deletedByName: user.name,
            deleteReason: `Merged into ${contactName(keep)}`,
          },
        });
      });
    }

    const movedSummary = Object.entries(moved).map(([label, n]) => `${n} ${label}`).join(", ") || "no linked records";
    await logAudit({
      action: "contact.merged",
      summary: `Merged ${others.map((o) => contactName(o)).join(", ")} into ${contactName(keep)} — moved ${movedSummary} — ${reason}`,
      contactId: keepId,
      user,
      metadata: { mergedIds: others.map((o) => o.id), moved },
    });
    revalidatePath("/contacts");
    revalidatePath("/duplicates");
    revalidatePath(`/contacts/${keepId}`);
    return { success: `Merged into ${contactName(keep)}.`, redirectTo: `/contacts/${keepId}` };
  });
}

/**
 * Reassign the loser's portal access grants (as viewer or grantee) to the winner
 * one at a time, dropping self-grants and any that would collide with a grant the
 * winner already holds (or one already reassigned this pass) — the two partial
 * unique indexes would otherwise fail the whole merge transaction.
 */
async function mergePortalGrants(tx: Prisma.TransactionClient, keepId: string, otherId: string) {
  const grants = await tx.portalAccessGrant.findMany({
    where: { OR: [{ viewerContactId: otherId }, { grantedContactId: otherId }] },
  });
  if (grants.length === 0) return;
  const winnerGrants = await tx.portalAccessGrant.findMany({
    where: { OR: [{ viewerContactId: keepId }, { grantedContactId: keepId }] },
  });
  const contactKeys = new Set<string>();
  const fleetKeys = new Set<string>();
  for (const g of winnerGrants) {
    if (g.grantedContactId) contactKeys.add(`${g.viewerContactId}|${g.grantedContactId}`);
    if (g.fleetId) fleetKeys.add(`${g.viewerContactId}|${g.fleetId}`);
  }
  for (const g of grants) {
    const viewer = g.viewerContactId === otherId ? keepId : g.viewerContactId;
    const granted = g.grantedContactId === otherId ? keepId : g.grantedContactId;
    // A self-grant (winner granting access to itself) is meaningless — drop it.
    if (granted && viewer === granted) {
      await tx.portalAccessGrant.delete({ where: { id: g.id } });
      continue;
    }
    const contactKey = granted ? `${viewer}|${granted}` : null;
    const fleetKey = g.fleetId ? `${viewer}|${g.fleetId}` : null;
    if ((contactKey && contactKeys.has(contactKey)) || (fleetKey && fleetKeys.has(fleetKey))) {
      await tx.portalAccessGrant.delete({ where: { id: g.id } });
      continue;
    }
    await tx.portalAccessGrant.update({ where: { id: g.id }, data: { viewerContactId: viewer, grantedContactId: granted } });
    if (contactKey) contactKeys.add(contactKey);
    if (fleetKey) fleetKeys.add(fleetKey);
  }
}
