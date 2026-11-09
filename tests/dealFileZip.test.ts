import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadStream, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, BlobReader } from "@zip.js/zip.js";
import { primeStream, safeName, winAnsi, zipPasswordProblem, zipPaths, dealZipFileName } from "../src/lib/dealFileZipRules";
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
  assert.ok(!entry.directory);
  assert.equal(new TextDecoder().decode(await entry.getData(new Uint8ArrayWriter(), { password: "correct horse battery" })), "deal paper");
  await assert.rejects(entry.getData(new Uint8ArrayWriter(), { password: "wrong password!" }));
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
  // (The word in "password-protected" is prose, not the variable.)
  const code = route.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line) && /\bpassword\b(?!-)/.test(line)).map((line) => line.trim());
  assert.deepEqual(code, [
    'const password = String(form.get("password") ?? "");',
    'const problem = zipPasswordProblem(password, String(form.get("confirm") ?? ""));',
    "const zip = new ZipWriter(writable, { password, encryptionStrength: 3, zipCrypto: false, useWebWorkers: false });",
  ]);
  assert.match(route, /"deal\.file_downloaded"/);
});

/** A stored file as local storage opens it (storage.ts openStoredFile): createReadStream, made a web stream. */
const localStream = (path: string) => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;

test("a stored file deleted before it is read is caught BEFORE its ZIP entry starts (review of #1051)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dealzip-"));
  const there = join(dir, "there.pdf");
  const gone = join(dir, "gone.pdf");
  const empty = join(dir, "empty.txt");
  writeFileSync(there, "a deal paper");
  writeFileSync(gone, "deleted before download");
  writeFileSync(empty, "");
  const goneStream = localStream(gone); // opening succeeds…
  unlinkSync(gone); // …the file disappears…
  await assert.rejects(primeStream(goneStream)); // …and priming is where it is found out.
  // A file that is there comes through whole, and an empty one is not mistaken for a missing one.
  assert.equal(await new Response(await primeStream(localStream(there))).text(), "a deal paper");
  assert.equal(await new Response(await primeStream(localStream(empty))).text(), "");
  rmSync(dir, { recursive: true, force: true });
});

test("a missing file is left out and the ZIP still completes — unprimed, it broke the whole archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dealzip-"));
  const there = join(dir, "there.pdf");
  writeFileSync(there, "kept");
  const build = async (prime: boolean) => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const zip = new ZipWriter(writable, { password: "correct horse battery", encryptionStrength: 3, zipCrypto: false, useWebWorkers: false });
    const bytes = new Response(readable).arrayBuffer();
    bytes.catch(() => {}); // the unprimed run aborts the stream; its reader is not what this test is about
    const missing: string[] = [];
    const files = [{ path: "Q-1/gone.pdf", file: join(dir, "never-existed.pdf") }, { path: "Q-1/there.pdf", file: there }];
    try {
      for (const { path, file } of files) {
        let stream = localStream(file);
        if (prime) {
          try {
            stream = await primeStream(stream);
          } catch {
            missing.push(path);
            continue;
          }
        }
        await zip.add(path, stream);
      }
      await zip.close();
    } catch {
      await writable.abort(new Error("failed")).catch(() => {});
      return { ok: false as const, missing };
    }
    return { ok: true as const, missing, raw: new Uint8Array(await bytes) };
  };
  const unprimed = await build(false);
  assert.equal(unprimed.ok, false, "the old way: one missing file and there is no archive at all");
  const primed = await build(true);
  assert.ok(primed.ok);
  assert.deepEqual(primed.missing, ["Q-1/gone.pdf"]);
  const entries = await new ZipReader(new BlobReader(new Blob([primed.raw!]))).getEntries();
  assert.deepEqual(entries.map((e) => e.filename), ["Q-1/there.pdf"]);
  rmSync(dir, { recursive: true, force: true });
});

test("the audit says what happened: the request, then the outcome with what went in and what was left out", () => {
  const route = src("src/app/api/deals/[id]/file-zip/route.ts");
  const requested = route.indexOf('await audit("deal.file_download_requested"');
  const closed = route.indexOf("await zip.close();");
  const downloaded = route.indexOf('"deal.file_downloaded"');
  const failed = route.indexOf('audit("deal.file_download_failed"');
  assert.ok(requested > 0 && requested < route.indexOf("new TransformStream"), "the request is logged before streaming");
  assert.ok(closed > 0 && downloaded > closed, "success is logged only after the archive is closed");
  assert.ok(failed > downloaded, "a failure is logged in the catch");
  assert.match(route, /\$\{added\} file\$\{added === 1 \? "" : "s"\} and the cover sheet/, "the count is what was ADDED, not what was planned");
  assert.match(route, /\$\{missing\.length\} missing from storage and left out/);
  // Every stored file is primed inside the per-file recovery, before its entry starts.
  assert.match(route, /try \{\s*stream = await primeStream\(await open\(\)\);\s*\} catch \{\s*missing\.push\(id\);\s*return;\s*\}\s*await zip\.add\(path, stream\);/);
  assert.match(route, /void runInTenantScope\(\{ tenantId, system: false \}, async \(\) => \{/);
});

test("a nested folder stays nested, and no level can climb out", () => {
  assert.deepEqual(
    zipPaths([{ folder: "Q-1025/Handover photos", name: "001 Front of cart.jpg" }, { folder: "Q-1025/../../x", name: "a.jpg" }]),
    ["Q-1025/Handover photos/001 Front of cart.jpg", "Q-1025/folder/folder/x/a.jpg"],
  );
});

test("handover photos: in the deal file and the ZIP, own workspace, delivery checklist only, Automotive only (Tekili Farm)", () => {
  const loader = src("src/lib/dealFileData.ts");
  assert.match(loader, /checklistPhoto\.findMany\(\{\s*where: \{ tenantId, entry: \{ run: \{ tenantId, hostType: "quote\.delivery", hostId: \{ in: dealQuoteIds \} \} \} \}/);
  assert.match(loader, /dealQuoteIds\.length && \(await isModuleEnabled\("automotive"\)\)/);
  const page = src("src/app/(app)/deals/[id]/page.tsx");
  assert.match(page, /handoverPhotos\.length > 0 &&/);
  assert.match(page, /storedFileSrc\(photo\.url\)/, "through the workspace-checked file route, never the raw store URL");
  const route = src("src/app/api/deals/[id]/file-zip/route.ts");
  assert.match(route, /addStored\(photoPaths\[i\], photo\.id, async \(\) => \(await openStoredFile\(photo\.url, tenantId\)\)\.stream\)/);
  assert.match(route, /folder: `Q-\$\{numberOf\.get\(photo\.quoteId\) \?\? quote\.number\}\/Handover photos`/);
});

test("the deal page and the ZIP read the deal file through ONE loader", () => {
  const page = src("src/app/(app)/deals/[id]/page.tsx");
  assert.match(page, /await loadDealFile\(quote, user\)/);
  assert.doesNotMatch(page, /dealFileChecklist\(/, "the page must not build its own checklist any more");
});
