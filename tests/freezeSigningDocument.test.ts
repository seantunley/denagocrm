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
