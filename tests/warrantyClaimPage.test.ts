import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// Gap audit #20 (second half): warranty claims had no page of their own — a line
// on the vehicle and a row in the Warranty list, with an empty
// warranty/[id]/layout.tsx and no page under it.
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(app)/warranty/[id]/page.tsx";

test("a claim has its own page, guarded by the page itself", () => {
  assert.ok(existsSync(new URL(`../${PAGE}`, import.meta.url)));
  const page = src(PAGE);
  assert.match(page, /const user = await requireAnyPermission\("warranty\.view", "warranty\.manage"\);/);
  assert.match(page, /await requireVehicleReadAccess\(claim\.vehicleId\);/);
  // Forms only with the manage grant (the actions check it again).
  assert.match(page, /const canManage = await hasPermission\(user, "warranty\.manage"\);/);
  assert.match(page, /\{canManage \? \(\s*<SaveForm action=\{updateWarrantyClaimDescription\.bind\(null, claim\.id\)\}/);
  assert.match(page, /\{canManage \? \(\s*<SaveForm action=\{setWarrantyClaimStatus\.bind\(null, claim\.id\)\}/);
  // Deleting from the page leaves it for the list.
  assert.match(page, /action=\{deleteWarrantyClaimFromPage\.bind\(null, claim\.id\)\}/);
  // User is global: only the name is read.
  assert.match(page, /prisma\.user\.findUnique\(\{ where: \{ id: claim\.createdById \}, select: \{ name: true \} \}\)/);
});

test("the claim actions say why they refused instead of failing silently", () => {
  const actions = src("src/app/actions/warranty.ts");
  const slice = (name: string) => actions.slice(actions.indexOf(`export async function ${name}(`), actions.indexOf("\nexport async function ", actions.indexOf(`export async function ${name}(`) + 10));
  for (const name of ["setWarrantyClaimStatus", "updateWarrantyClaimDescription"]) {
    const body = slice(name);
    assert.match(body, /return asActionResult\(async \(\) => \{\s*(\/\/[^\n]*\n\s*)*await requirePermission\("warranty\.manage"\);/, `${name} authorises first`);
    assert.match(body, /if \(!existing\) refuse\(/);
    assert.match(body, /await requireVehicleAccess\(existing\.vehicleId, "warranty\.manage"\);/);
  }
  assert.match(slice("setWarrantyClaimStatus"), /refuse\("Choose a status for the claim\."\)/);
  assert.doesNotMatch(slice("setWarrantyClaimStatus"), /\)\) return;/, "no silent return on a bad status");
  assert.match(slice("updateWarrantyClaimDescription"), /refuse\("Describe the fault\."\)/);
  assert.match(slice("deleteWarrantyClaimFromPage"), /return result\.error \? result : \{ success: "Claim deleted", redirectTo: "\/warranty" \};/);
});

test("the list and the vehicle page link to the claim", () => {
  assert.match(src("src/app/(app)/warranty/page.tsx"), /<Link href=\{`\/warranty\/\$\{claim\.id\}`\}/);
  assert.match(src("src/app/(app)/vehicles/[id]/page.tsx"), /<Link href=\{`\/warranty\/\$\{c\.id\}`\}[^>]*>Open<\/Link>/);
});
