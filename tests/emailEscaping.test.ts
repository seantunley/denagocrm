import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { escapeHtml } from "../src/lib/escapeHtml";

const root = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

test("the encoder is safe in text and in a quoted attribute", () => {
  // Element content.
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  // Attribute value, either quoting style — this is the position the tenant
  // name actually sits in (alt="…"), and the one that was unescaped.
  assert.equal(escapeHtml('" onerror="alert(1)'), "&quot; onerror=&quot;alert(1)");
  assert.equal(escapeHtml("' onload='x"), "&#39; onload=&#39;x");

  // Ampersand FIRST, or the entities introduced below it get double-encoded and
  // an ordinary trading name renders wrong.
  assert.equal(escapeHtml("Smith & Co"), "Smith &amp; Co");
  assert.equal(escapeHtml("A & <b>"), "A &amp; &lt;b&gt;");
  assert.doesNotMatch(escapeHtml("Smith & Co"), /&amp;amp;/);

  // Ordinary names pass through untouched — escaping must not disfigure the
  // common case.
  for (const plain of ["Acme Motors", "Denago Cape Town", "Müller GmbH", "O Brien"]) {
    assert.equal(escapeHtml(plain), plain);
  }
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("a tenant name cannot alter the markup of a campaign email", () => {
  const campaigns = read("src/lib/campaigns.ts");
  // The three positions the review found: an alt attribute, the footer, and the
  // "you received this because" sentence.
  assert.match(campaigns, /const safeName = escapeHtml\(name\)/);
  assert.match(campaigns, /alt="\$\{safeName\}"/, "the alt attribute must be escaped");
  assert.match(campaigns, /const footer = safeName;/, "the footer must be escaped");
  assert.match(campaigns, /a \$\{safeName\} customer/, "the body sentence must be escaped");
  // The raw value must not survive anywhere in the template.
  assert.doesNotMatch(campaigns, /alt="\$\{name\}"/);
  assert.doesNotMatch(campaigns, /a \$\{name\} customer/);
});

test("there is one encoder, not a copy per file", () => {
  // Two private copies and a third surface with none is how this happened. The
  // failure was never picking the wrong encoder — it was reaching for none —
  // so the fix is that there is only one to reach for.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = path.join(dir, entry);
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry)) files.push(rel);
    }
  };
  walk("src/lib");

  const definers = files.filter(
    (file) => file !== path.join("src", "lib", "escapeHtml.ts") && /function escapeHtml\s*\(/.test(read(file)),
  );
  assert.deepEqual(definers, [], `these define a private HTML encoder instead of importing the shared one:\n${definers.join("\n")}`);
});
