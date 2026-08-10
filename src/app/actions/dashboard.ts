"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse } from "@/lib/actionResult";
import type { ActionResult } from "@/lib/actionResultTypes";
import {
  DASHBOARD_CARD_IDS,
  DEFAULT_LAYOUT,
  MAX_CARDS,
  normaliseLayout,
} from "@/lib/dashboard/registry";

/**
 * Saving and resetting a user's dashboard arrangement.
 *
 * WHOSE LAYOUT. Every function here derives the owning user from the SESSION
 * (`requireUser()`), never from an argument. There is deliberately no `userId`
 * parameter anywhere in this file: a server action is reachable by direct POST,
 * so a userId in the payload would be an invitation to write — or read back —
 * somebody else's dashboard. The only id that can ever reach the `where` clause
 * is the caller's own.
 *
 * TENANCY. These go through the scoped `prisma` client, not `basePrisma`, so the
 * tenant extension stamps `tenantId` on create and adds it to the `where` on
 * read and update once enforcement is on. No `$queryRaw`, no `basePrisma`, so no
 * hand-written tenant predicate is needed here.
 *
 * NO PERMISSION KEY. Arranging your own home screen is not a privileged act, and
 * inventing a `dashboard.manage` permission would mean every existing role had
 * to be granted it before anyone could move a card. `requireUser()` is the whole
 * gate. WHAT the cards may show is decided elsewhere, per card, per request —
 * see src/lib/dashboard/registry.ts. A layout is only a list of names; it
 * confers nothing.
 */

/**
 * The wire format. A bare array of known card ids.
 *
 * `z.enum` over the id tuple means an unknown id is REFUSED on the way in,
 * rather than stored and then silently dropped on every subsequent read. Both
 * ends are defended: the write path rejects what it does not recognise, and the
 * read path (`normaliseLayout`) drops what it no longer recognises — because a
 * card removed in a later release turns a once-valid stored id into an unknown
 * one, and by then no amount of input validation can help.
 */
const layoutSchema = z.array(z.enum(DASHBOARD_CARD_IDS)).max(MAX_CARDS);

/** Find the caller's layout row id, if they have one. */
async function ownLayoutId(userId: string): Promise<string | null> {
  const row = await prisma.dashboardLayout.findFirst({
    where: { userId },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Write the caller's layout.
 *
 * findFirst-then-update/create rather than `upsert`: the unique key is
 * `(tenantId, userId)` and `tenantId` is NULL while tenancy is dormant, so an
 * upsert's `where` would never match an existing row and every save would insert
 * a duplicate. The partial unique index added in migration 20260804100000 is
 * what makes the race safe — a concurrent double-save loses one insert to a
 * P2002 rather than creating a second layout — so that collision is caught and
 * retried as an update.
 */
async function writeLayout(userId: string, cards: string[]): Promise<void> {
  const existing = await ownLayoutId(userId);
  if (existing) {
    await prisma.dashboardLayout.update({ where: { id: existing }, data: { cards } });
    return;
  }
  try {
    // NOT on the 2026-08-10 audit list only because production happens to hold no
    // unsaved-layout rows — the defect is the sibling of the Dashboard one and is
    // fixed here for the same reason. The doc comment above already spells it
    // out: the unique key is `(tenantId, userId)` and `tenantId` is NULL while
    // tenancy is dormant, so the constraint does not bind and migration
    // 20260804100000 had to carry a partial index to cover the race. Naming the
    // acting workspace is what retires that workaround.
    await prisma.dashboardLayout.create({ data: { tenantId: await actingTenantId(), userId, cards } });
  } catch {
    // Lost the insert race, or the row appeared between the read and the write.
    // Re-resolve and update; if it is still absent the error was something else
    // and must not be swallowed.
    const raced = await ownLayoutId(userId);
    if (!raced) throw new Error("Could not save the dashboard layout");
    await prisma.dashboardLayout.update({ where: { id: raced }, data: { cards } });
  }
}

/**
 * Persist a new card order / membership for the signed-in user.
 *
 * Called on every drop and on every add/remove — see the note on immediate
 * saving in DashboardGrid. Returns an ActionResult so a refusal is a value the
 * client can show, not an opaque production error digest.
 */
export async function saveDashboardLayout(cards: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const parsed = layoutSchema.safeParse(cards);
    if (!parsed.success) refuse("That dashboard layout could not be saved.");
    // Re-run the read-path normaliser over the validated ids so the stored value
    // obeys the same invariants the renderer assumes — deduped and capped. Zod
    // proves each id is real; this proves the LIST is well formed.
    await writeLayout(user.id, normaliseLayout(parsed.data));
    revalidatePath("/");
  });
}

/** Put the signed-in user's dashboard back to the default arrangement. */
export async function resetDashboardLayout(): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    await writeLayout(user.id, [...DEFAULT_LAYOUT]);
    revalidatePath("/");
  });
}
