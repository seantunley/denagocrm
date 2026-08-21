/**
 * WHERE a checklist can be attached — the host registry.
 *
 * This is the answer to "tie these lists to other modules", and it is
 * deliberately a closed catalogue written out by hand rather than anything
 * derived. A run addresses its subject as `hostType` + `hostId`, which Postgres
 * cannot constrain, so this file is the only thing that decides which host
 * strings are real, what permission each one demands, and which module pack owns
 * it. A host that is not in here does not exist: no template can be configured
 * for it, no run can be started against it, and no upload token will be issued.
 *
 * Adding a fifth host is an entry here plus a resolver in ./hostRecords.ts — not
 * a migration, and not a new table.
 *
 * ── WHY THIS FILE IS PURE ───────────────────────────────────────────────────
 *
 * No Prisma, no `server-only`. The rules below are the ones most worth testing,
 * and a module that constructs a PrismaClient cannot be imported by
 * `node --test`. The half that actually touches the database — "does this quote
 * exist, and is it this tenant's?" — lives in ./hostRecords.ts, and a guard
 * fails the build if the two ever disagree about which hosts exist.
 *
 * Same split as lib/dashboard/sources.ts and lib/dashboard/compile.ts, for the
 * same reason.
 */
import type { PermissionKey } from "@/lib/permissions";
import type { ModuleId } from "@/lib/modules/registry";

/**
 * A host id is `<record>.<situation>`, and the situation half matters as much as
 * the record half: a job card is checked at BOOKING-IN and again at HANDOVER,
 * and those are different lists asking different questions of the same vehicle.
 * Collapsing them to "jobcard" would force one list to serve both and lose the
 * ability to say which moment a photo describes.
 */
export const HOST_IDS = [
  "quote.delivery",
  "jobcard.checkin",
  "jobcard.checkout",
  "vehicle.condition",
] as const;

export type HostId = (typeof HOST_IDS)[number];

export type HostDef = {
  id: HostId;
  /** Shown in the template editor's "this list is for…" picker. */
  label: string;
  /** One line, so somebody configuring a list knows when it will be asked for. */
  description: string;
  /**
   * The permission required BOTH to run this checklist and to be issued an
   * upload token for its photos. It is the same key the host record's own screen
   * demands — a checklist must never be a way to attach evidence to a record you
   * could not otherwise touch.
   */
  permission: PermissionKey;
  /**
   * The module pack that owns this host. When the pack is off for the tenant the
   * host does not exist: no templates offered, no runs startable. Module state
   * is a TENANT entitlement, permission is WHO — both apply, independently.
   */
  module?: ModuleId;
  /**
   * Which Prisma model the `hostId` points at. Used only by ./hostRecords.ts;
   * named here so the catalogue is readable in one place.
   */
  model: "quote" | "jobCard" | "vehicle";
  /** Where a run links back to, with `:id` substituted. */
  href: string;
};

export const HOSTS: readonly HostDef[] = [
  {
    id: "quote.delivery",
    label: "Delivery handover",
    description: "Captured when a cart is handed over to the customer.",
    permission: "deliveries.manage",
    model: "quote",
    href: "/deliveries",
  },
  {
    id: "jobcard.checkin",
    label: "Workshop check-in",
    description: "Captured when a vehicle arrives, before any work starts.",
    permission: "jobcards.manage",
    module: "automotive",
    model: "jobCard",
    href: "/jobcards/:id",
  },
  {
    id: "jobcard.checkout",
    label: "Workshop check-out",
    description: "Captured when the vehicle goes back to the customer.",
    permission: "jobcards.manage",
    module: "automotive",
    model: "jobCard",
    href: "/jobcards/:id",
  },
  {
    id: "vehicle.condition",
    label: "Vehicle condition report",
    description: "A standalone condition record against a vehicle, at any time.",
    permission: "vehicles.manage",
    module: "automotive",
    model: "vehicle",
    href: "/vehicles/:id",
  },
];

const HOST_BY_ID = new Map<string, HostDef>(HOSTS.map((h) => [h.id, h]));

export function hostById(id: string): HostDef | undefined {
  return HOST_BY_ID.get(id);
}

export function isHostId(value: unknown): value is HostId {
  return typeof value === "string" && HOST_BY_ID.has(value);
}

export type HostAccess = {
  permissions: ReadonlySet<string>;
  modules: ReadonlySet<string>;
};

/**
 * May this viewer use this host at all?
 *
 * Both gates, independently, and neither is optional. Identical in shape to
 * `canSeeCard` in lib/dashboard/registry.ts and `canUseSource` in
 * lib/dashboard/sources.ts — three catalogues, one rule, so none of them can
 * drift into a different idea of who may see what.
 */
export function canUseHost(host: HostDef, access: HostAccess): boolean {
  if (host.module && !access.modules.has(host.module)) return false;
  return access.permissions.has(host.permission);
}

/** The hosts offered in the template editor, for this viewer. */
export function usableHosts(access: HostAccess): HostDef[] {
  return HOSTS.filter((host) => canUseHost(host, access));
}

/** Where a completed run links back to. */
export function hostHref(host: HostDef, hostId: string): string {
  return host.href.replace(":id", encodeURIComponent(hostId));
}
