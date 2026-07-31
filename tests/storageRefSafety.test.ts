import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * A storage ref used to be trusted completely: readFile() sent anything starting
 * with https:// to fetch(), and everything else to path.join(UPLOAD_DIR, ref).
 * That was fine while every ref came from saveFile(), and stopped being fine the
 * moment one caller stored a client-supplied URL — registerLibraryDocuments took
 * `url` straight off a server-action argument and wrote it as storedName.
 *
 * Two primitives fell out, both reachable by a holder of library.manage and both
 * returning the bytes through GET /api/library/[id]:
 *   "../../../../proc/self/environ"  → arbitrary file read (DATABASE_URL,
 *                                      blob tokens, SESSION_SECRET)
 *   "https://<internal-host>/..."    → SSRF, response body handed back
 */

test("storage refuses a ref that is neither our blob host nor a bare filename", () => {
  const code = src("src/lib/storage.ts");
  assert.match(code, /function classifyRef/, "refs must be classified, not assumed");
  assert.match(code, /Refusing an unrecognised storage reference/, "and refused when neither");
  // Throwing rather than returning a boolean is deliberate: a caller that
  // forgets to check would otherwise fall through to the local-file branch.
  const classify = code.slice(code.indexOf("function classifyRef"), code.indexOf("const isBlobRef"));
  assert.match(classify, /throw new Error/);
});

test("only our own blob host is fetchable", () => {
  // Without a host check, `https://` + anything makes the server fetch it and
  // return the body — SSRF with a response oracle.
  const code = src("src/lib/storage.ts");
  assert.match(code, /blob\\\.vercel-storage\\\.com\$/, "the trusted host must be anchored");
  const trusted = code.slice(code.indexOf("function isTrustedBlobRef"), code.indexOf("function isLocalRef"));
  assert.match(trusted, /protocol === "https:"/, "http:// must not qualify");
});

test("a local ref cannot traverse out of the upload directory", () => {
  const code = src("src/lib/storage.ts");
  const local = code.slice(code.indexOf("function isLocalRef"), code.indexOf("function classifyRef"));
  for (const guard of ['includes("/")', 'includes("\\\\")', "isAbsolute"]) {
    assert.ok(local.includes(guard), `a bare filename check must reject ${guard}`);
  }
  assert.match(local, /ref !== "\.\."/, "…and the traversal segment itself");
});

test("the library actions refuse a bad ref before it reaches the database", () => {
  // Defence at the boundary is the durable fix, but a bad value should never be
  // persisted either — a stored bad ref is a landmine for the next reader.
  const code = src("src/app/actions/library.ts");
  assert.match(code, /function assertBlobUrl/);
  assert.match(code, /blob\\\.vercel-storage\\\.com\$/i);
  // Both writers must call it. registerLibraryDocuments takes an array,
  // registerLibraryVersion a single file.
  assert.match(code, /for \(const file of files\) assertBlobUrl\(file\.url\)/, "the bulk register must check every file");
  assert.match(code, /\n  assertBlobUrl\(file\.url\);/, "the single-version register must check its file");
  // Every storedName write is covered.
  const writes = (code.match(/storedName: file\.url/g) ?? []).length;
  const checks = (code.match(/assertBlobUrl\(/g) ?? []).length - 1; // minus the definition
  assert.equal(checks, writes, "every storedName write site needs a matching check");
});
