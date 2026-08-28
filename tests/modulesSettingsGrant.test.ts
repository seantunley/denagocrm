import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { effectiveModuleIds, grantedModuleIds } from "../src/lib/modules/entitlement";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Settings → Modules writes ONE of the two layers.
 *
 *   GRANT          Tenant.modules — what the workspace MAY use (platform admin)
 *   LOCAL DISABLE  DISABLED_MODULES — what it switched off (this screen)
 *
 * Effective = granted MINUS disabled. So a pack that was never granted rendered
 * as an unchecked box was a control that could not work: ticking it wrote the
 * disable list correctly, the module stayed off, and the box came back unticked.
 * On 2026-08-28 that was reasonably read as "it doesn't save" — the setting had
 * saved perfectly, and nothing on screen could say otherwise.
 */

test("TICKING AN UNGRANTED PACK CHANGES NOTHING — the maths, not the UI", () => {
  // Exactly the production shape: automation absent from the grant, and absent
  // from the disable list too (the user had already ticked it).
  const grant = "automotive,commerce,inbox,marketing,portal,support";
  const effective = effectiveModuleIds(grant, []);
  assert.equal(effective.has("automation"), false, "no local choice can add a pack to the grant");
  // …and granting it is what actually turns it on.
  assert.equal(effectiveModuleIds(`automation,${grant}`, []).has("automation"), true);
});

test("a granted pack is what the local list can then switch off", () => {
  const grant = "automation,marketing";
  assert.equal(effectiveModuleIds(grant, []).has("automation"), true);
  assert.equal(effectiveModuleIds(grant, ["automation"]).has("automation"), false);
});

test("mandatory packs are granted unconditionally", () => {
  // `core` is not stored in the grant and must never be revocable.
  assert.equal(grantedModuleIds("").has("core"), true);
  assert.equal(grantedModuleIds(null).has("core"), true);
});

/* ── what the screen must now say ────────────────────────────────────────── */

test("an ungranted pack is disabled and labelled, not silently unchecked", () => {
  const page = src("src/app/(app)/settings/modules/page.tsx");
  assert.match(page, /grantedModuleIdsForRequest/, "the page must read the grant, not only the effective set");
  assert.match(page, /const available = Boolean\(m\.mandatory\) \|\| granted\.has\(m\.id\)/);
  // Disabled, so it cannot be ticked AND posts nothing — the save can never even
  // appear to ask for something the grant forbids.
  assert.match(page, /disabled=\{Boolean\(m\.mandatory\) \|\| !available\}/);
  assert.match(page, /Not in your plan/, "and it must say why it cannot be used");
  assert.match(page, /platform administrator/, "…and who can change it");
});

test("the grant reader fails closed, never install-wide", () => {
  /*
   * A tenant that cannot be resolved must not be shown every pack as available.
   * The effective set already fails closed for `scoped-but-unresolved`; the
   * grant reader has to make the same choice or the screen would offer packs the
   * workspace was never granted.
   */
  const enabled = src("src/lib/modules/enabled.ts");
  const fn = enabled.slice(enabled.indexOf("export async function grantedModuleIdsForRequest"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /scoped-but-unresolved/);
  assert.match(body, /grantedModuleIds\(""\)/, "an unresolved scope yields mandatory modules only");
});
