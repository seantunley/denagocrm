import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../src/lib/doceditor/model";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";
import {
  STANDARD_TEMPLATE_KEYS,
  standardTemplateFor,
} from "../src/lib/doceditor/standardTemplates";

test("all operational templates use the current document model", () => {
  assert.deepEqual(STANDARD_TEMPLATE_KEYS, [
    "quote",
    "invoice",
    "agreement",
    "indemnity",
    "delivery",
    "jobcard",
    "service-report",
    "warranty-claim",
  ]);

  for (const key of STANDARD_TEMPLATE_KEYS) {
    const template = standardTemplateFor(key);
    assert.ok(parseDocument(template), `${key} should parse as a DocumentModel`);
    assert.ok(template.pages.length > 0, `${key} should contain a page`);
    assert.ok(
      template.pages.some((page) => page.rows.length > 0),
      `${key} should contain visible rows`,
    );
  }
});

test("terms blocks do not contain unresolved merge tokens", () => {
  for (const key of STANDARD_TEMPLATE_KEYS) {
    const template = standardTemplateFor(key);
    const terms = template.pages.flatMap((page) =>
      page.rows.flatMap((row) =>
        row.columns.flatMap((column) =>
          column.blocks.filter((block) => block.type === "terms"),
        ),
      ),
    );
    for (const block of terms) {
      if (block.type !== "terms") continue;
      assert.equal(block.title.includes("{{"), false, `${key} terms title`);
      for (const item of block.items) {
        assert.equal(item.text.includes("{{"), false, `${key} terms item`);
      }
    }
  }
});

test("bound templates resolve record and company tokens", () => {
  const invoice = standardTemplateFor("invoice");
  const html = renderDocumentHtml(invoice, {
    tokens: {
      "quote.number": "Q-1234",
      "quote.date": "17 Jul 2026",
      "quote.total": "R 100,000.00",
      "customer.name": "Test Customer",
      "customer.phone": "0123456789",
      "customer.email": "customer@example.com",
      "customer.address": "Cape Town",
      "company.name": "Denago Cape Town",
      "company.address": "Maitland, Cape Town",
      "company.phone": "073 789 3438",
      "company.email": "sales@example.com",
      preparedBy: "Sean",
    },
    items: [],
    vars: {},
    bound: true,
  });

  assert.match(html, /Q-1234/);
  assert.match(html, /Test Customer/);
  assert.match(html, /Denago Cape Town/);
  assert.doesNotMatch(html, /\{\{quote\.number\}\}/);
  assert.doesNotMatch(html, /\{\{company\.name\}\}/);
});
