import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MODULE_REGISTRY, OPTIONAL_MODULE_IDS, moduleForPath, moduleForPermission } from "../src/lib/modules/registry";
import { effectiveModuleIds, installWideModuleIds } from "../src/lib/modules/entitlement";
import { ticketTypesOffered } from "../src/lib/helpdesk-constants";
import { vehicleWorkshop, workshopSummary, type FleetVehicle } from "../src/lib/workshopRules";
import { selfKnowledge } from "../src/lib/assistantSoul";
import { isArticleEnabled } from "../src/lib/help/modules";
import type { ModuleId } from "../src/lib/modules/registry";

/**
 * Sean, 2026-11-21: "Warranty must be a completely seperate module and everything warranty related needs to be removed
 * from the CRM, should the warranty module be off." Off = hidden everywhere (pages, menus, vehicle/stock/fleet/job-card
 * panels, the portal, help desk types, document templates, report columns, DAX, help, notifications). Records are kept.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const NOW = new Date("2026-11-21T08:00:00+02:00");

test("its own switchable module, built on Automotive; /warranty and warranty.* belong to it", () => {
  const mod = MODULE_REGISTRY.find((m) => m.id === "warranty");
  assert.ok(mod && OPTIONAL_MODULE_IDS.includes("warranty"));
  assert.equal(mod!.requires, "automotive");
  assert.equal(moduleForPath("/warranty"), "warranty");
  assert.equal(moduleForPath("/warranty/abc/print"), "warranty", "the claim's print-out too");
  assert.ok(!MODULE_REGISTRY.find((m) => m.id === "automotive")!.routePrefixes.includes("/warranty"));
  assert.equal(moduleForPermission("warranty.view"), "warranty");
  assert.equal(moduleForPermission("warranty.manage"), "warranty");
  assert.equal(moduleForPermission("vehicles.view_all"), null);
  // Granted + Automotive: on. Switched off, or Automotive off: off. Automotive stays on without it.
  assert.ok(effectiveModuleIds("automotive,warranty", []).has("warranty"));
  assert.ok(!effectiveModuleIds("automotive,warranty", ["warranty"]).has("warranty"));
  assert.ok(effectiveModuleIds("automotive,warranty", ["warranty"]).has("automotive"));
  assert.ok(!effectiveModuleIds("warranty", []).has("warranty"), "no Automotive, no Warranty");
  assert.ok(!installWideModuleIds(["automotive"]).has("warranty"));
});

test("every workspace with Automotive is granted it, once", () => {
  const sql = code("prisma/migrations/20261121110000_grant_warranty_module/migration.sql");
  assert.match(sql, /SET "modules" = "modules" \|\| ',warranty'/);
  assert.match(sql, /WHERE 'automotive' = ANY \(string_to_array\(replace\(coalesce\("modules", ''\), ' ', ''\), ','\)\)\s*AND NOT \('warranty' = ANY/);
});

test("off: nobody holds warranty.* — not even the owner — so every claims screen, button and action goes with it", () => {
  const perms = code("src/lib/permissions.ts");
  const has = perms.slice(perms.indexOf("export async function hasPermission"), perms.indexOf("export async function requirePermission"));
  assert.match(has, /if \(!\(await moduleHolds\(permission\)\)\) return false;\s*if \(user\.role === "owner"\) return true;/);
  assert.match(has, /for \(const permission of permissions\) if \(await moduleHolds\(permission\)\) live\.push\(permission\);\s*if \(live\.length === 0\) return false;\s*if \(user\.role === "owner"\) return true;/);
  assert.match(perms, /const id = moduleForPermission\(permission\);\s*return !id \|\| \(await isModuleEnabled\(id\)\);/);
});

test("off: hidden on vehicles, stock, fleets and job cards; a form without the field never clears the stored term", () => {
  const vehicle = code("src/app/(app)/vehicles/[id]/page.tsx");
  assert.match(vehicle, /const canSeeWarranty = await hasAnyPermission\(currentUser, \.\.\.WARRANTY_READ\);/);
  assert.match(vehicle, /\{canSeeWarranty && \(\(\) => \{\s*const w = computeWarranty\(vehicle\);/);
  assert.match(vehicle, /canSeeWarranty && analysis\.warrantyEligible/);
  assert.match(code("src/components/VehicleForm.tsx"), /\{showWarranty && \(\s*<CaptureField label="Warranty term \(months\)">/);
  for (const page of ["src/app/(app)/vehicles/page.tsx", "src/app/(app)/vehicles/new/page.tsx", "src/app/(app)/vehicles/[id]/edit/page.tsx"]) {
    assert.match(code(page), /showWarranty=\{/, page);
  }
  assert.match(code("src/app/actions/vehicles.ts"), /\.\.\.\(formData\.has\("warrantyMonths"\) \? \{ warrantyMonths: int\("warrantyMonths"\) \} : \{\}\),/);
  const stock = code("src/app/(app)/stock/[id]/page.tsx");
  assert.match(stock, /\{warrantyOn && <div><label className="label">Warranty months<\/label>/);
  assert.match(stock, /\{warrantyOn && unit\.warrantyStartAt && \(/);
  const fleet = code("src/app/(app)/fleets/[id]/page.tsx");
  assert.match(fleet, /\.\.\.\(warrantyOn \? \[\{ label: "In warranty", value: inWarranty \}\] : \[\]\)/);
  assert.match(fleet, /\{warrantyOn && <th>Warranty<\/th>\}/);
  assert.match(code("src/app/(app)/jobcards/[id]/page.tsx"), /\{warrantyOn && \(\s*<SaveForm success="Warranty updated"/);
  assert.match(code("src/app/actions/jobcards.ts"), /if \(!\(await isModuleEnabled\("warranty"\)\)\) refuse\("Warranty is switched off for this workspace\."\);/);
  assert.match(code("src/app/(app)/jobcards/insights/page.tsx"), /\.\.\.\(warrantyOn \? \[\{ label: "Warranty recovered"/);
});

test("off: the portal shows no cover or warranty requests, and a warranty request becomes plain support", () => {
  const portal = code("src/app/portal/page.tsx");
  assert.match(portal, /const warrantyOn = await isModuleEnabled\("warranty"\);/);
  assert.match(portal, /\{warrantyOn && <span className=\{`badge \$\{warrantyColors\[warranty\.status\]\}`\}>/);
  // This owner's claims only (claimsSince, vehicle transfer), and only with the module on.
  assert.match(portal, /\{warrantyOn && claims\.length > 0 && \(/);
  assert.match(code("src/components/PortalExpansionForms.tsx"), /\{warranty && <option value="warranty">Warranty request<\/option>\}/);
  assert.match(code("src/app/portal/support/page.tsx"), /warranty=\{warrantyOn\}/);
  assert.match(code("src/app/actions/portalExpansion.ts"), /if \(type === "warranty" && !\(await isModuleEnabled\("warranty"\)\)\) type = "support";/);
});

test("off: help desk offers no warranty type; existing cases keep theirs", () => {
  assert.deepEqual(ticketTypesOffered(false), ["support", "delivery", "billing", "sales", "other"]);
  assert.ok(ticketTypesOffered(true).includes("warranty"));
  assert.match(code("src/app/actions/helpdesk.ts"), /const offered = ticketTypesOffered\(await isModuleEnabled\("warranty"\)\)/);
  assert.match(code("src/app/(app)/cases/page.tsx"), /const types = ticketTypesOffered\(warrantyOn\);/);
});

test("off: DAX says nothing about cover, claims or warranties ending, and doesn't claim to know them", () => {
  const cart: FleetVehicle = {
    id: "v1", model: "Nomad XL", regNumber: "CA 1", owner: "Sipho", purchaseDate: new Date("2026-01-01"), warrantyMonths: 24,
    serviceIntervalKm: null, serviceIntervalMonths: null, serviceRecords: [], mileageLogs: [],
    batteryChecks: [{ checkedAt: new Date("2026-11-01"), stateOfHealth: 55 }],
  };
  const off = vehicleWorkshop(cart, NOW, true, false) as Record<string, unknown>;
  assert.equal(off.warranty, undefined);
  assert.equal(off.warrantyUntil, undefined);
  assert.equal(off.batteryWarrantyClaimCandidate, undefined);
  assert.equal((vehicleWorkshop(cart, NOW, true) as Record<string, unknown>).warranty, "In warranty", "on: as before");
  assert.equal("warrantiesEnding" in workshopSummary([cart], NOW, 5, false), false);
  assert.ok("warrantiesEnding" in workshopSummary([cart], NOW, 5));
  assert.match(code("src/lib/workshopContext.ts"), /isModuleEnabled\("warranty"\),/);
  const modules = (ids: string[]) => new Set(ids as ModuleId[]);
  assert.doesNotMatch(selfKnowledge("DAX", modules(["core", "automotive"])), /warrant/i);
  assert.match(selfKnowledge("DAX", modules(["core", "automotive", "warranty"])), /warranty claims/);
});

test("off: no warranty claim template, report column, help article or notification toggle", () => {
  assert.match(code("src/lib/docTemplates.ts"), /label: "Warranty claim",\s*group: "Workshop",\s*\/\/[^\n]*\n\s*module: "warranty",/);
  assert.match(code("src/lib/dashboard/sources.ts"), /key: "underWarranty"[^\n]*module: "warranty" \}/);
  assert.match(code("src/lib/dashboard/sources.ts"), /key: "warrantyMonths"[^\n]*module: "warranty" \}/);
  assert.match(code("src/lib/dashboard/compile.ts"), /modules: access\.modules, usable: true/);
  const article = { slug: "warranty-claims-recalls", category: "workshop" as const };
  assert.equal(isArticleEnabled(article, new Set<ModuleId>(["core", "automotive"])), false);
  assert.equal(isArticleEnabled(article, new Set<ModuleId>(["core", "automotive", "warranty"])), true);
  assert.match(code("src/app/(app)/settings/page.tsx"), /PUSH_KINDS\.filter\(\(k\) => k\.id !== "warranty" \|\| enabled\.has\("warranty"\)\)/);
  assert.match(code("src/app/actions/settings.ts"), /id === "warranty" && !warrantyShown \? before\.has\(id\) : !enabled\.has\(id\)/, "a hidden toggle keeps its choice");
  assert.match(code("src/app/(print)/warranty/[id]/print/document/route.ts"), /if \(!\(await isModuleEnabled\("warranty"\)\)\) \{/);
});
