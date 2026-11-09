import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, BlobReader } from "@zip.js/zip.js";
import { safeName, winAnsi, zipPasswordProblem, zipPaths, dealZipFileName } from "../src/lib/dealFileZipRules";
import { coverSheetPdf } from "../src/lib/dealFileCover";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the password: at least 10 characters, at most 128, typed the same twice", () => {
  assert.match(zipPasswordProblem("short", "short") ?? "", /at least 10/);
  assert.match(zipPasswordProblem("x".repeat(129), "x".repeat(129)) ?? "", /at most 128/);
  assert.match(zipPasswordProblem("long enough pw", "long enough pW") ?? "", /don't match/);
  assert.equal(zipPasswordProblem("long enough pw", "long enough pw"), null);
});

test("names inside the ZIP: no path tricks, reserved characters or clashes", () => {
  assert.equal(safeName("../../etc/passwd"), "etc passwd");
  assert.equal(safeName('a:b*c?"d<e>f|g.pdf'), "a b c d e f g.pdf");
  assert.equal(safeName("   "), "file");
  assert.ok(safeName(`${"x".repeat(300)}.pdf`).endsWith(".pdf"));
  assert.ok(safeName(`${"x".repeat(300)}.pdf`).length <= 120);
  assert.deepEqual(
    zipPaths([{ folder: "Q-1029", name: "Invoice.pdf" }, { folder: "Q-1029", name: "INVOICE.pdf" }, { folder: "Q-1029", name: "Invoice.pdf" }, { folder: null, name: "x" }]),
    ["Q-1029/Invoice.pdf", "Q-1029/INVOICE (2).pdf", "Q-1029/Invoice (3).pdf", "x"],
  );
  assert.equal(dealZipFileName(1029), "Deal file Q-1029.zip");
});

test("the cover sheet prints any customer name — what the font can't draw becomes ?, never an error", async () => {
  assert.equal(winAnsi("Zoë Müller — O’Brien → done ✓ 漢"), "Zoë Müller — O’Brien -> done x ?");
  const pdf = await coverSheetPdf({
    brand: "Denago", title: "Q-1 · 漢字 Ünïcode", generatedAt: "now", generatedBy: "Sean",
    quotes: [{ label: "Q-1", status: "accepted", total: "R 1.00", created: "today" }],
    checklist: [{ label: "Quote", done: true, detail: "" }, { label: "Invoice", done: false, detail: "Not on file → upload it" }],
    suppliers: [], files: Array.from({ length: 120 }, (_, i) => ({ path: `Q-1/f${i}.pdf`, type: "Invoice", detail: "" })), notes: [],
  });
  assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), "%PDF-");
});

test("the ZIP is AES-256: opens with the password, refuses any other", async () => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const zip = new ZipWriter(writable, { password: "correct horse battery", encryptionStrength: 3, zipCrypto: false, useWebWorkers: false });
  const bytes = new Response(readable).arrayBuffer();
  await zip.add("Q-1/a.txt", new Uint8ArrayReader(new TextEncoder().encode("deal paper")));
  await zip.close();
  const raw = new Uint8Array(await bytes);
  // Local header: method 99 = WinZip AES; extra field 0x9901 with strength 3 = AES-256.
  const view = new DataView(raw.buffer);
  assert.equal(view.getUint16(8, true), 99);
  const nameLength = view.getUint16(26, true);
  const extra = raw.slice(30 + nameLength, 30 + nameLength + view.getUint16(28, true));
  assert.equal(new DataView(extra.buffer).getUint16(0, true), 0x9901);
  assert.equal(extra[8], 3);

  const [entry] = await new ZipReader(new BlobReader(new Blob([raw]))).getEntries();
  assert.equal(new TextDecoder().decode(await entry.getData!(new Uint8ArrayWriter(), { password: "correct horse battery" })), "deal paper");
  await assert.rejects(entry.getData!(new Uint8ArrayWriter(), { password: "wrong password!" }));
});

test("the route: POST, same-site, the page's own gates and loader, workspace at the door, AES-256, streamed", () => {
  const route = src("src/app/api/deals/[id]/file-zip/route.ts");
  assert.match(route, /export async function POST\(/);
  assert.doesNotMatch(route, /export async function GET\(/, "a password never goes in a URL");
  assert.match(route, /if \(!isSameOrigin\(request\.headers\)\) return text\(/);
  assert.match(route, /await requireRoute\("\/deals"\);\s*const user = await requireQuoteReadAccess\(id\);/);
  assert.match(route, /quote\.tenantId !== tenantId\) return text\(/);
  assert.match(route, /const file = await loadDealFile\(quote, user\);/);
  assert.match(route, /isAutomotiveOwnedDocument\(doc\)/);
  assert.match(route, /new ZipWriter\(writable, \{ password, encryptionStrength: 3, zipCrypto: false, useWebWorkers: false \}\)/);
  assert.match(route, /return new Response\(readable,/);
  // The password goes to the check and the encryptor and nowhere else: every line of code naming it is one of these.
  const code = route.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line) && /\bpassword\b/.test(line)).map((line) => line.trim());
  assert.deepEqual(code, [
    'const password = String(form.get("password") ?? "");',
    'const problem = zipPasswordProblem(password, String(form.get("confirm") ?? ""));',
    "const zip = new ZipWriter(writable, { password, encryptionStrength: 3, zipCrypto: false, useWebWorkers: false });",
  ]);
  assert.match(route, /action: "deal\.file_downloaded"/);
});

test("the deal page and the ZIP read the deal file through ONE loader", () => {
  const page = src("src/app/(app)/deals/[id]/page.tsx");
  assert.match(page, /await loadDealFile\(quote, user\)/);
  assert.doesNotMatch(page, /dealFileChecklist\(/, "the page must not build its own checklist any more");
});
