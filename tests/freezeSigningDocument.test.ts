import test from "node:test";
import assert from "node:assert/strict";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { freezeDocumentGlobals } from "../src/lib/signing/freezeDocument";

test("company and date globals are frozen throughout a signing snapshot", () => {
  const source = standardTemplateFor("indemnity");
  const frozen = freezeDocumentGlobals(source, {
    "company.name": "Denago Cape Town",
    "company.tagline": "Electric lifestyle vehicles",
    "company.address": "Maitland",
    "company.phone": "073 789 3438",
    "company.email": "sales@example.com",
    "company.website": "denagocpt.co.za",
    "date.today": "17 Jul 2026",
  });
  const json = JSON.stringify(frozen);
  assert.match(json, /Denago Cape Town/);
  assert.match(json, /17 Jul 2026/);
  assert.doesNotMatch(json, /\{\{company\./);
  assert.doesNotMatch(json, /\{\{date\.today\}\}/);

  const changedLater = freezeDocumentGlobals(frozen, {
    "company.name": "Changed Company",
    "date.today": "18 Jul 2026",
  });
  const changedJson = JSON.stringify(changedLater);
  assert.match(changedJson, /Denago Cape Town/);
  assert.match(changedJson, /17 Jul 2026/);
  assert.doesNotMatch(changedJson, /Changed Company/);
});

test("variables inserted from the picker are frozen too, not only typed {{tokens}}", () => {
  const source = standardTemplateFor("indemnity");
  const pill = (token: string) => ({ type: "mergeField", token, children: [{ text: "" }] });
  const text = { ...source.pages[0].rows[0].columns[0].blocks[0], type: "text", value: [{ type: "p", children: [pill("date.today"), pill("user.name"), pill("customer.name")] }] };
  const doc = { ...source, pages: [{ ...source.pages[0], rows: [{ ...source.pages[0].rows[0], columns: [{ ...source.pages[0].rows[0].columns[0], blocks: [text] }] }] }] };
  const json = JSON.stringify(freezeDocumentGlobals(doc as typeof source, { "date.today": "29 Sep 2026", "user.name": "Sean" }));
  assert.match(json, /"text":"29 Sep 2026"/);
  assert.match(json, /"text":"Sean"/);
  assert.doesNotMatch(json, /"token":"date\.today"/);
  // A record variable is not a global — it stays a variable, bound when rendered.
  assert.match(json, /"token":"customer\.name"/);
});
