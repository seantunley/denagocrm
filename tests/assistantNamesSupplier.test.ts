import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { matchVendorByName } from "../src/lib/vendors";
import { ACTION_INSTRUCTIONS, parseActionList } from "../src/lib/assistantActions";

/** DAX names the supplier when it files a supplier paper ("file this as Wrap Studio's invoice"), 2026-11-09. */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const vendors = [{ id: "v1", name: "Wrap Studio (Pty) Ltd" }, { id: "v2", name: "Denago" }, { id: "v3", name: "Cape Carts Transport" }, { id: "v4", name: "Cape Carts Wraps" }];

test("the supplier is matched by name without case, punctuation or the company form", () => {
  assert.deepEqual(matchVendorByName("wrap studio", vendors), { vendor: vendors[0] });
  assert.deepEqual(matchVendorByName("Denago", vendors), { vendor: vendors[1] });
  // A part of one name, and only one: that one.
  assert.deepEqual(matchVendorByName("Transport", vendors), { vendor: vendors[2] });
  // A part of two names: no guess.
  assert.deepEqual(matchVendorByName("Cape Carts", vendors), { ambiguous: [vendors[2], vendors[3]] });
  assert.deepEqual(matchVendorByName("Nobody Ltd", vendors), { none: true });
  assert.deepEqual(matchVendorByName("  ", vendors), { none: true });
});

test("attach_file takes a supplier name", () => {
  const action = { type: "attach_file", quote: "Q-1030", label: "Supplier invoice", supplier: "Wrap Studio" };
  assert.deepEqual(parseActionList([action]), [action]);
  // Told how to use it.
  assert.match(ACTION_INSTRUCTIONS, /"supplier": the supplier's name as they said it/);
});

test("the proposal resolves the supplier among the workspace's own, asks when it can't, and Confirm passes it on", () => {
  const plan = read("src/lib/crmAssistant.ts");
  const attach = plan.slice(plan.indexOf('if (p.type === "attach_file") {'), plan.indexOf('if (p.type === "record_payment") {'));
  assert.match(attach, /where: \{ tenantId: await actingTenantId\(\), deletedAt: null \}/, "this workspace's suppliers only");
  assert.match(attach, /if \(!p\.supplier\) \{ problems\.push\(`Which supplier is this/);
  assert.match(attach, /const match = matchVendorByName\(p\.supplier, vendors\);/);
  assert.match(attach, /if \("ambiguous" in match\) \{ problems\.push\(/);
  assert.match(attach, /\.\.\.\(vendor \? \{ vendorId: vendor\.id \} : \{\}\)/);
  assert.doesNotMatch(attach, /upload it from the deal file, or file it here without a type/, "DAX no longer refuses supplier papers");
  // Only with the Suppliers module on.
  assert.match(attach, /\(supplierType \|\| p\.supplier\) && \(await isModuleEnabled\("suppliers"\)\)/);

  const confirm = read("src/app/actions/assistant.ts");
  const card = confirm.slice(confirm.indexOf('case "attach_file": {'), confirm.indexOf('case "record_payment": {'));
  assert.match(card, /\.\.\.\(card\.vendorId \? \{ vendorId: card\.vendorId \} : \{\}\)/);
  assert.match(card, /if \(card\.vendorId !== undefined && typeof card\.vendorId !== "string"\) return untouched\(STALE_CARD\);/);
});
