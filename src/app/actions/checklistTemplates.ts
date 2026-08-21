"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { basePrisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import {
  getUserPermissionList,
  requirePermission,
  type PermissionKey,
  type PermissionUser,
} from "@/lib/permissions";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { SECTION } from "@/lib/dashboard/config";
import { isSecurityRelevant } from "@/lib/dashboard/conditions";
import { canUseHost, hostById, type HostDef } from "@/lib/checklists/hosts";
import {
  CHECKLIST_LIMITS,
  TEMPLATE_INPUT,
  templateProblems,
  type ChecklistItemInput,
} from "@/lib/checklists/types";

/**
 * Configuring guided checklists. The capture half is
 * src/app/actions/checklistRuns.ts; the read path is lib/checklists/store.ts.
 *
 * ── WHO MAY CONFIGURE ONE ───────────────────────────────────────────────────
 *
 * Two gates, and neither is sufficient alone.
 *
 * `document_templates.manage` is the SETTINGS gate. Configuring a list is an
 * administrative act performed once, in Settings, on behalf of everybody who will
 * later fill it in — it is not the same act as filling one in, and gating it on
 * the permission the CAPTURE side uses would mean every technician who may
 * photograph a vehicle may also rewrite what everyone is asked to photograph. The
 * key is the catalogue's existing "may configure a reusable template that other
 * modules then instantiate": it already gates /settings/documents and the
 * Document Studio, and — the reason it is the right one here — it is not tied to
 * any one module. A checklist template can be for a delivery, a workshop
 * check-in or a vehicle condition report, so a per-module key such as
 * `workshop.manage` would either deny configuration for three of the four hosts
 * or grant it on the strength of an unrelated one.
 *
 * `canUseHost` is the HOST gate, applied second. Holding the settings key does not
 * mean a person may build a list for a situation they cannot reach: a workspace
 * with the automotive pack switched off has no workshop check-in to configure for,
 * and somebody without `deliveries.manage` should not be authoring the questions
 * on a handover they may not perform. Same rule the picker uses (`usableHosts`),
 * so the editor cannot offer a host the save would refuse.
 *
 * ── ONE DEFINITION OF "IF" ──────────────────────────────────────────────────
 *
 * A step's `visibility` is parsed by the DASHBOARD's condition schema, reached
 * through `SECTION.shape.visibility`. Not a copy of it, and not a second grammar:
 * the journey builder, the dashboards and this now share one definition of what a
 * condition is, so a rule someone learns in one place means the same thing in the
 * others. (config.ts does not export the schema under its own name; the object it
 * hangs off is exported, and the shape is the same instance. See the report.)
 *
 * ── VERSION ─────────────────────────────────────────────────────────────────
 *
 * `version` is stamped onto every run and is what lets a completed handover say
 * which revision of the list it answered. It is bumped when the ITEMS change and
 * not otherwise — see `itemsChanged`.
 */

/** The settings-level key. See the header for why this one. */
const CONFIGURE_CHECKLISTS: PermissionKey = "document_templates.manage";

/** Where the editor lives, so a save is visible on the next render. */
const SETTINGS_PATH = "/settings/checklists";

/**
 * The dashboards' own condition schema, reused rather than restated.
 *
 * `ITEM_INPUT.visibility` is deliberately `z.unknown()` — types.ts is pure and
 * cannot import a module that pulls in the card registry — so this is where the
 * grammar is actually enforced, on the way in, once.
 */
const VISIBILITY = SECTION.shape.visibility;

/* ── helpers ──────────────────────────────────────────────────────────── */

/**
 * A zod failure as a sentence the person who typed it can act on.
 *
 * Typed structurally rather than as `z.ZodError` so it also accepts the error a
 * nested schema produces, and so a zod major version cannot break the signature
 * of a two-line message helper.
 */
function firstIssue(error: { issues: ReadonlyArray<{ message: string; path: PropertyKey[] }> }): string {
  const issue = error.issues[0];
  const where = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
  return `${issue?.message ?? "That checklist could not be read"}${where}`;
}

/**
 * The host a template names, or a refusal.
 *
 * `TEMPLATE_INPUT` has already proved the string is one of `HOST_IDS`, so this
 * cannot fail in practice — and it is checked anyway, because a host id that
 * parses but has no catalogue entry would otherwise be configured for a situation
 * with no permission attached to it.
 */
function resolveHost(id: string): HostDef {
  const host = hostById(id);
  if (!host) refuse("That checklist target is not something this app knows about.");
  return host;
}

/**
 * The SETTINGS gate, on its own.
 *
 * Separated from the host gate because three of the four actions have to read the
 * row before they know which host to check — and reading first and authorising
 * afterwards is the ordering that produces "we already told you it exists"
 * disclosures. This runs first, always; the host gate follows once the situation
 * is known.
 */
async function requireChecklistSettings(): Promise<PermissionUser> {
  return requirePermission(CONFIGURE_CHECKLISTS);
}

/** The HOST gate: may this person configure lists for this situation at all? */
async function requireUsableHost(user: PermissionUser, host: HostDef): Promise<void> {
  const [permissions, modules] = await Promise.all([
    getUserPermissionList(user),
    getEnabledModuleIds(),
  ]);
  if (
    !canUseHost(host, {
      permissions: new Set<string>(permissions),
      modules: new Set<string>(modules),
    })
  ) {
    refuse(`${host.label} is not available in this workspace, so there is nothing to configure for it.`);
  }
}

/** Both gates, for the paths that know the host before they read anything. */
async function requireChecklistConfigurer(host: HostDef): Promise<PermissionUser> {
  const user = await requireChecklistSettings();
  await requireUsableHost(user, host);
  return user;
}

/**
 * A step's visibility rule, ready for the Json column.
 *
 * An absent or empty rule CLEARS the column (`DbNull`) rather than storing a JSON
 * `null`. The renderer treats an absent rule as "always visible", and a stored
 * null would be a value it has to know to ignore — one more thing to get wrong in
 * the direction that hides a step nobody meant to hide.
 */
function visibilityFor(item: ChecklistItemInput): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (item.visibility === undefined || item.visibility === null) return Prisma.DbNull;
  const parsed = VISIBILITY.safeParse(item.visibility);
  if (!parsed.success) {
    refuse(`The "show this step when…" rule on "${item.label}" could not be read.`);
  }
  if ((parsed.data ?? []).some(isSecurityRelevant)) {
    refuse(`The visibility rule on "${item.label}" cannot depend on screen size because checklist steps are validated by the server.`);
  }
  if (!parsed.data || parsed.data.length === 0) return Prisma.DbNull;
  // Stringified for the same reason dashboardConfig.ts does it: a parsed
  // condition carries optional keys as explicit `undefined`, which Prisma's
  // InputJsonValue does not admit and which would otherwise be stored as null.
  return JSON.parse(JSON.stringify(parsed.data)) as Prisma.InputJsonValue;
}

type StoredItem = {
  id: string;
  label: string;
  description: string | null;
  capture: string;
  required: boolean;
  minPhotos: number;
  maxPhotos: number;
  visibility: unknown;
  sortOrder: number;
};

/**
 * Did this edit change what the list ASKS?
 *
 * The version is not an edit counter. It is stamped onto every run, and its only
 * job is to let a completed handover say which revision of the list it answered —
 * so it must move when the questions move and stay still when they do not.
 *
 * Adding a step, removing one, renaming one, changing what it collects, changing
 * whether it is required, or changing how many photos it needs are all changes to
 * what a person is asked and what "finished" means. Renaming the TEMPLATE is not:
 * "Delivery handover" becoming "Handover (delivery)" asks nobody anything new, and
 * bumping for it would leave a workspace's runs scattered across a dozen revisions
 * that are all the same list. Guidance, ordering, visibility and the upper photo
 * bound are included because they change what the device renders or may collect.
 */
function itemsChanged(existing: StoredItem[], incoming: ChecklistItemInput[]): boolean {
  const before = new Map(existing.map((item) => [item.id, item]));
  const kept = new Set<string>();
  for (const item of incoming) {
    // No id, or an id this template does not own, is a NEW step either way — see
    // the note in `saveChecklistTemplate` on why a foreign id is never adopted.
    const prior = item.id ? before.get(item.id) : undefined;
    if (!prior) return true;
    kept.add(prior.id);
    if (prior.label !== item.label) return true;
    if ((prior.description ?? "") !== (item.description ?? "")) return true;
    if (prior.capture !== item.capture) return true;
    if (prior.required !== item.required) return true;
    if (prior.minPhotos !== item.minPhotos) return true;
    if (prior.maxPhotos !== item.maxPhotos) return true;
    if (prior.sortOrder !== incoming.indexOf(item)) return true;
    const nextVisibility = item.visibility == null ? null : JSON.parse(JSON.stringify(item.visibility));
    if (JSON.stringify(prior.visibility) !== JSON.stringify(nextVisibility)) return true;
  }
  return kept.size !== existing.length;
}

function revisionItems(items: Array<{
  id: string;
  label: string;
  description: string | null;
  capture: string;
  required: boolean;
  minPhotos: number;
  maxPhotos: number;
  visibility: unknown;
  sortOrder: number;
}>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(items.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    capture: item.capture,
    required: item.required,
    minPhotos: item.minPhotos,
    maxPhotos: item.maxPhotos,
    visibility: item.visibility ?? null,
    sortOrder: item.sortOrder,
  })))) as Prisma.InputJsonValue;
}

/* ── save ─────────────────────────────────────────────────────────────── */

/**
 * Create or replace a configured list.
 *
 * `templateId` is null for a new one. It is resolved WITHIN the acting workspace,
 * so an id belonging to another business simply does not match and is reported as
 * "no longer available" — the same answer as an id that never existed.
 *
 * ITEM IDS ARE NEVER ADOPTED. An incoming step carrying an id this template does
 * not own is created fresh with an id the database mints, rather than updated.
 * The alternative — `update where: { id }` on whatever the client sent — is a way
 * to reach into another template (or another workspace's) and rewrite a step,
 * dragging every entry already recorded against it along with the new wording.
 *
 * Steps the payload omits are DELETED, and that is safe here for a reason worth
 * naming: `ChecklistEntry.itemId` is SET NULL rather than cascaded, so removing a
 * step from the list removes the question and leaves every photograph already
 * taken against it exactly where it is, still readable through its snapshots.
 */
export async function saveChecklistTemplate(
  templateId: string | null,
  input: unknown,
): Promise<ActionResult> {
  return asActionResult(async () => {
    /*
     * THE SETTINGS GATE RUNS BEFORE THE PAYLOAD IS EVEN DESCRIBED.
     *
     * `firstIssue` names which field is wrong and where, which is precisely what
     * makes it useful to somebody probing the shape of a configuration API they
     * have no business calling. The host gate cannot come first — it needs the
     * parsed payload to know which host is being configured — so the two are
     * split: capability now, situation once it is known.
     */
    const user = await requireChecklistSettings();
    const parsed = TEMPLATE_INPUT.safeParse(input);
    if (!parsed.success) refuse(firstIssue(parsed.error));
    const template = parsed.data;

    const host = resolveHost(template.host);
    await requireUsableHost(user, host);
    // The workspace is resolved HERE, from the session, and is never taken from
    // the payload. A server action is a POST endpoint: a `tenantId` argument
    // would be an invitation to file one business's configuration under another.
    const tenantId = await actingTenantId();

    const problems = templateProblems(template);
    if (problems.length > 0) refuse(problems[0]);

    // Resolved before the transaction opens: `visibilityFor` refuses, and a
    // refusal thrown mid-transaction would roll back a write that had already
    // reported nothing wrong with the first six steps.
    const items = template.items.map((item, index) => ({
      input: item,
      visibility: visibilityFor(item),
      // POSITION IS THE ORDER. The editor sends the steps in the order it shows
      // them, so taking the order from the array removes the case where two
      // steps hold the same `sortOrder` and swap places between renders.
      sortOrder: index,
    }));

    if (!templateId) {
      const created = await basePrisma.$transaction(async (tx) => {
        const row = await tx.checklistTemplate.create({
          data: {
            tenantId,
            host: template.host,
            name: template.name,
            description: template.description ?? null,
            active: template.active,
            sortOrder: template.sortOrder,
            version: 1,
            items: {
              create: items.map(({ input: item, visibility, sortOrder }) => ({
                tenantId,
                label: item.label,
                description: item.description ?? null,
                capture: item.capture,
                required: item.required,
                minPhotos: item.minPhotos,
                maxPhotos: item.maxPhotos,
                visibility,
                sortOrder,
              })),
            },
          },
          select: { id: true, name: true, version: true },
        });
        const stored = await tx.checklistItem.findMany({
          where: { tenantId, templateId: row.id },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true, label: true, description: true, capture: true, required: true, minPhotos: true, maxPhotos: true, visibility: true, sortOrder: true },
        });
        await tx.checklistTemplateRevision.create({
          data: { tenantId, templateId: row.id, version: row.version, items: revisionItems(stored) },
        });
        return row;
      });
      await logAudit({
        action: "checklist.template_created",
        summary: `Created checklist “${created.name}” for ${host.label}`,
        user,
      });
      revalidatePath(SETTINGS_PATH);
      return { success: `“${created.name}” saved` };
    }

    const existing = await basePrisma.checklistTemplate.findFirst({
      where: { id: templateId, tenantId },
      select: {
        id: true,
        host: true,
        name: true,
        version: true,
        items: { select: { id: true, label: true, description: true, capture: true, required: true, minPhotos: true, maxPhotos: true, visibility: true, sortOrder: true } },
      },
    });
    if (!existing) refuse("That checklist is no longer available in this workspace.");
    // MOVING A LIST BETWEEN SITUATIONS IS NOT AN EDIT. Runs stamped against it
    // answered questions asked about a delivery; re-pointing the template at a
    // workshop check-in would retroactively file them under the wrong moment, and
    // `syncChecklistRun` would then refuse every device still holding one.
    if (existing.host !== template.host) {
      refuse("A checklist cannot be moved to a different situation. Create a new one instead.");
    }

    const known = new Set(existing.items.map((item) => item.id));
    const surviving = template.items
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && known.has(id));
    const bump = itemsChanged(existing.items, template.items);

    await basePrisma.$transaction(async (tx) => {
      // `updateMany` rather than `update`, so the tenant is named in the call
      // itself. `existing` was already resolved tenant-scoped, so this changes no
      // behaviour — but a write that carries its own scope cannot be detached
      // from the read that justified it by a later edit, and the sibling
      // deleteMany below already names it. The ratchet in
      // tests/tenantAccessRatchet.test.ts holds every new tenant-owned write to
      // this shape for exactly that reason.
      await tx.checklistTemplate.updateMany({
        where: { id: existing.id, tenantId },
        data: {
          name: template.name,
          description: template.description ?? null,
          active: template.active,
          sortOrder: template.sortOrder,
          ...(bump ? { version: existing.version + 1 } : {}),
        },
      });
      // Removed steps first, so a label freed by a deletion can be reused by a
      // step created in the same save without tripping the duplicate-name rule.
      await tx.checklistItem.deleteMany({
        where: {
          templateId: existing.id,
          tenantId,
          ...(surviving.length > 0 ? { id: { notIn: surviving } } : {}),
        },
      });
      for (const { input: item, visibility, sortOrder } of items) {
        const data = {
          label: item.label,
          description: item.description ?? null,
          capture: item.capture,
          required: item.required,
          minPhotos: item.minPhotos,
          maxPhotos: item.maxPhotos,
          visibility,
          sortOrder,
        };
        if (item.id && known.has(item.id)) {
          // Scoped by template AND workspace, not by id alone: the id has been
          // proved to be ours, and the predicate says so at the point of writing
          // rather than relying on a check three statements further up.
          await tx.checklistItem.updateMany({
            where: { id: item.id, templateId: existing.id, tenantId },
            data,
          });
        } else {
          await tx.checklistItem.create({ data: { ...data, tenantId, templateId: existing.id } });
        }
      }
      const version = existing.version + (bump ? 1 : 0);
      const stored = await tx.checklistItem.findMany({
        where: { tenantId, templateId: existing.id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, label: true, description: true, capture: true, required: true, minPhotos: true, maxPhotos: true, visibility: true, sortOrder: true },
      });
      await tx.checklistTemplateRevision.upsert({
        where: { tenantId_templateId_version: { tenantId, templateId: existing.id, version } },
        create: { tenantId, templateId: existing.id, version, items: revisionItems(stored) },
        update: {},
      });
    });

    await logAudit({
      action: "checklist.template_saved",
      summary: `Updated checklist “${template.name}” for ${host.label}${bump ? ` (now revision ${existing.version + 1})` : ""}`,
      user,
    });
    revalidatePath(SETTINGS_PATH);
    return {
      success: bump
        ? `“${template.name}” saved — revision ${existing.version + 1}`
        : `“${template.name}” saved`,
    };
  }, { scope: "checklist-template-save", context: `template=${templateId ?? "new"}` });
}

/* ── delete, activate, reorder ────────────────────────────────────────── */

/**
 * Remove a configured list entirely.
 *
 * REFUSED ONCE ANYTHING HAS ANSWERED IT. `ChecklistRun.templateId` is RESTRICT,
 * so the database would refuse this anyway — but it would refuse it as a
 * constraint violation, which reaches the person as a reference number and no
 * advice. The count below turns that into the sentence they need, and names the
 * thing they actually want: deactivating hides the list from every picker while
 * leaving what it recorded intact.
 */
export async function deleteChecklistTemplate(templateId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireChecklistSettings();
    const tenantId = await actingTenantId();
    const template = await basePrisma.checklistTemplate.findFirst({
      where: { id: templateId, tenantId },
      select: { id: true, host: true, name: true },
    });
    if (!template) refuse("That checklist is no longer available in this workspace.");
    await requireUsableHost(user, resolveHost(template.host));

    const runs = await basePrisma.checklistRun.count({ where: { templateId: template.id, tenantId } });
    if (runs > 0) {
      refuse(
        `“${template.name}” has been used ${runs} time${runs === 1 ? "" : "s"} and cannot be deleted — deactivate it instead, which stops it being offered without losing what it recorded.`,
      );
    }
    // Guarded, and re-asserting the workspace at the moment of the delete: the
    // count above is a moment old, and a run started in between must survive.
    // `deleteMany` also makes a row deleted by somebody else a no-op rather than
    // a P2025 the caller cannot act on.
    const { count } = await basePrisma.checklistTemplate.deleteMany({
      where: { id: template.id, tenantId, runs: { none: {} } },
    });
    if (count === 0) refuse(`“${template.name}” has just been used, so it can no longer be deleted.`);

    await logAudit({
      action: "checklist.template_deleted",
      summary: `Deleted checklist “${template.name}”`,
      user,
    });
    revalidatePath(SETTINGS_PATH);
    return { success: `“${template.name}” deleted` };
  }, { scope: "checklist-template-delete", context: `template=${templateId}` });
}

/**
 * Switch a list on or off.
 *
 * The safe alternative to deleting, and the only one available once a list has
 * been used. Deactivating removes it from every picker; runs already recorded
 * against it are untouched and stay readable.
 */
export async function setChecklistTemplateActive(
  templateId: string,
  active: boolean,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireChecklistSettings();
    const tenantId = await actingTenantId();
    const template = await basePrisma.checklistTemplate.findFirst({
      where: { id: templateId, tenantId },
      select: { id: true, host: true, name: true },
    });
    if (!template) refuse("That checklist is no longer available in this workspace.");
    await requireUsableHost(user, resolveHost(template.host));

    await basePrisma.checklistTemplate.updateMany({
      where: { id: template.id, tenantId },
      data: { active },
    });
    await logAudit({
      action: "checklist.template_active",
      summary: `${active ? "Activated" : "Deactivated"} checklist “${template.name}”`,
      user,
    });
    revalidatePath(SETTINGS_PATH);
    return { success: `“${template.name}” ${active ? "activated" : "deactivated"}` };
  }, { scope: "checklist-template-active", context: `template=${templateId}` });
}

/**
 * Rearrange the lists offered for one situation.
 *
 * The ids are filtered against what this workspace actually holds for this host
 * BEFORE anything is written, so an id from another business or another situation
 * cannot be renumbered by naming it here — it is simply not in the list. Anything
 * omitted keeps its position, which is what makes a partial payload harmless
 * rather than a silent collapse of the order.
 */
export async function reorderChecklistTemplates(
  hostId: string,
  orderedIds: string[],
): Promise<ActionResult> {
  return asActionResult(async () => {
    const host = resolveHost(hostId);
    const user = await requireChecklistConfigurer(host);
    const tenantId = await actingTenantId();

    const ids = z
      .array(z.string().min(1).max(40))
      .max(CHECKLIST_LIMITS.itemsPerTemplate * 4)
      .safeParse(orderedIds);
    if (!ids.success) refuse("That ordering could not be read.");

    const owned = new Set(
      (
        await basePrisma.checklistTemplate.findMany({
          where: { tenantId, host: host.id, id: { in: ids.data } },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    const ordered = ids.data.filter((id) => owned.has(id));
    if (ordered.length === 0) return {};

    await basePrisma.$transaction(
      ordered.map((id, index) =>
        basePrisma.checklistTemplate.updateMany({
          where: { id, tenantId, host: host.id },
          data: { sortOrder: index },
        }),
      ),
    );
    await logAudit({
      action: "checklist.templates_reordered",
      summary: `Reordered the checklists for ${host.label}`,
      user,
    });
    revalidatePath(SETTINGS_PATH);
    return { success: "Order saved" };
  }, { scope: "checklist-template-reorder", context: `host=${hostId}` });
}
