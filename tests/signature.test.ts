import assert from "node:assert/strict";
import test from "node:test";
import { buildSignature } from "../src/lib/signature";

test("branded signatures include the optional job title", () => {
  const html = buildSignature({
    name: "Ada Lovelace",
    email: "ada@example.com",
    jobTitle: "Sales Director",
  });
  assert.match(html, /Ada Lovelace/);
  assert.match(html, /Sales Director/);
});

test("branded signatures escape editable profile values", () => {
  const html = buildSignature({
    name: '<img src=x onerror="alert(1)">',
    email: "safe@example.com",
    mobile: "+27 <script>",
    jobTitle: "Sales & Support",
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Sales &amp; Support/);
});
