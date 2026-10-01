import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, document library: "too large", "not uploaded to the library",
// "no workspace on this sign-in" all threw from a server action — which in
// production arrives redacted, so the uploader showed a generic failure (and the
// remove button an error page). Now they come back as values.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const lib = src("src/app/actions/library.ts");

test("register (new + version) and delete return their refusals", () => {
  for (const name of ["registerLibraryDocuments", "registerLibraryVersion", "deleteLibraryDocument"]) {
    const at = lib.indexOf(`export async function ${name}(`);
    assert.ok(at >= 0, name);
    assert.match(lib.slice(at, at + 600), /return asActionResult\(async \(\) => \{/, name);
  }
  assert.doesNotMatch(lib, /throw new Error\(/);
  assert.doesNotMatch(lib, /findUniqueOrThrow\(/);
  assert.doesNotMatch(lib, /if \(!document\) return;/);
  assert.doesNotMatch(lib, /if \(files\.length === 0\) return;/);
});

test("the ownership checks are unchanged — only how they report", () => {
  assert.match(lib, /if \(!isLibraryUpload\(owned\.pathname, expectedTenantId\)\) \{\s*refuse\(/);
  assert.match(lib, /const owned = await assertOwnedBlob\(file\.url, expectedTenantId\);/);
});

test("the uploader surfaces a returned refusal", () => {
  const ui = src("src/components/LibraryUploader.tsx");
  assert.equal((ui.match(/if \(result\?\.error\) throw new Error\(result\.error\);/g) ?? []).length, 2);
});
