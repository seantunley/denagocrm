"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { requireContactAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";
import { withActingStaffScope } from "@/lib/actingScope";

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
export async function mergeContacts(keepId: string, otherIdsCsv: string) {
  return withActingStaffScope(async () => {
    const user = await requireContactAccess(keepId, "contacts.merge");
    const otherIds = otherIdsCsv.split(",").filter((id) => id && id !== keepId);
    if (otherIds.length === 0) return;
    for (const id of otherIds) await requireContactAccess(id, "contacts.merge");

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
        if (!winner) throw new Error("The contact being kept no longer exists.");
        // Reload the loser live (with tags). If it's already been merged/deleted by
        // a concurrent merge, skip it rather than acting on the stale pre-loop copy.
        const loser = await tx.contact.findFirst({ where: { id: other.id, deletedAt: null }, include: { tags: true } });
        if (!loser) return;

        const move = (
          p: { updateMany: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown> },
          field: string
        ) => p.updateMany({ where: { [field]: loser.id }, data: { [field]: keepId } });

        // Plain contactId reassignments.
        await move(tx.lead, "contactId");
        await move(tx.vehicle, "contactId");
        await move(tx.jobCard, "contactId");
        await move(tx.quote, "contactId");
        await move(tx.communication, "contactId");
        await move(tx.activity, "contactId");
        await move(tx.document, "contactId");
        await move(tx.auditLog, "contactId");
        await move(tx.consentRecord, "contactId");
        await move(tx.campaignRecipient, "contactId");
        await move(tx.researchNote, "contactId");
        await move(tx.conversation, "contactId");
        await move(tx.customerCase, "contactId");
        await move(tx.customerCaseMessage, "contactId");
        await move(tx.portalNotification, "contactId");
        await move(tx.portalProfileChangeRequest, "contactId");
        await move(tx.portalUpload, "contactId");
        await move(tx.fleet, "contactId");
        await move(tx.warrantyClaim, "contactId");
        await move(tx.surveyResponse, "contactId");
        await move(tx.signatureRequest, "contactId");
        await move(tx.docInstance, "contactId");

        // Referral has two contact links. Move both, then drop any self-referral
        // the merge created (referrer === referred → a customer referring itself,
        // which would hand them undue referral credit).
        await move(tx.referral, "referrerId");
        await move(tx.referral, "contactId");
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

    await logAudit({
      action: "contact.merged",
      summary: `Merged ${others.length} duplicate${others.length !== 1 ? "s" : ""} into ${contactName(keep)}`,
      contactId: keepId,
      user,
    });
    revalidatePath("/contacts");
    revalidatePath("/duplicates");
    revalidatePath(`/contacts/${keepId}`);
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
