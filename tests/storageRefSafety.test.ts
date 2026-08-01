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
  // Every storedName write must go through resolveUpload, which does the shape
  // check AND the ownership check. Both writers, spelled out — a count would
  // miss that the bulk path passes the function by reference to .map().
  assert.match(
    code,
    /await Promise\.all\(files\.map\(resolveUpload\)\)/,
    "the bulk register must resolve every file, and before it writes any of them",
  );
  assert.match(code, /const meta = await resolveUpload\(file\);/, "the single-version register too");
  const writes = (code.match(/storedName: file\.url/g) ?? []).length;
  assert.equal(writes, 2, "two writers — add a resolveUpload assertion if a third appears");
});

test("a hostname match is not an ownership claim", () => {
  // `*.blob.vercel-storage.com` is EVERY Vercel customer's store. A library
  // manager could register a stranger's object and the server would fetch it.
  // Ownership has to be decided by asking our own store with our own token.
  const code = src("src/lib/storage.ts");
  assert.match(code, /export async function assertOwnedBlob/);
  const owned = code.slice(code.indexOf("export async function assertOwnedBlob"), code.indexOf("function isLocalRef"));
  assert.match(owned, /head\(ref, \{ token \}\)/, "ownership is proven by resolving through our token");
  assert.match(owned, /privateToken\(\), publicToken\(\)/, "both configured stores count as ours");
  assert.match(owned, /Refusing a Blob URL that is not in our store/);
});

test("stored size and content type come from the store, never from the caller", () => {
  // sizeBytes and mimeType arrived from the browser next to the URL, so the
  // declared size bore no relation to what would actually be downloaded.
  const code = src("src/app/actions/library.ts");
  assert.doesNotMatch(code, /sizeBytes: file\.sizeBytes/, "the caller's size must not be persisted");
  assert.match(code, /sizeBytes: meta\.sizeBytes/);
  assert.match(code, /sizeBytes: owned\.size/, "the persisted size is the store's number");
  assert.match(code, /mimeType: owned\.contentType/);
});

test("a blob read is bounded, twice", () => {
  // arrayBuffer() buffered whatever arrived. The declared size is a claim, so it
  // is checked before fetching AND enforced per chunk while reading.
  const code = src("src/lib/storage.ts");
  assert.doesNotMatch(code, /await res\.arrayBuffer\(\)/, "an unbounded buffer is a memory-exhaustion lever");
  assert.match(code, /export const MAX_BLOB_BYTES/);
  assert.match(code, /if \(meta\.size > MAX_BLOB_BYTES\)/, "refuse before fetching a byte");
  assert.match(code, /if \(total > cap\)/, "and while reading, because a header is only a claim");
  assert.match(code, /reader\.cancel\(\)/, "stop pulling once the cap is hit");
});

test("the blob read is bounded in time as well as size", () => {
  // Review finding: a streamed size cap says nothing about a host that accepts
  // the connection and then never sends a byte. Two different properties.
  const code = src("src/lib/storage.ts");
  assert.match(code, /const BLOB_FETCH_TIMEOUT_MS = \d/);
  assert.match(code, /fetch\(ref, \{ signal: AbortSignal\.timeout\(BLOB_FETCH_TIMEOUT_MS\) \}\)/);
});

test("the dead signing-PDF path cannot be revived as an SSRF", () => {
  // src/lib/signedPdf.ts has NO importers today (the greps that look like hits
  // are the unrelated signedPdfHash / signedPdfRef column names), so this is not
  // an active path. It fetched a caller-supplied dealerSignatureUrl with no
  // validation at all, which is a loaded gun for whoever revives it.
  const code = src("src/lib/signedPdf.ts");
  assert.doesNotMatch(code, /fetch\(input\.dealerSignatureUrl/, "no bare fetch of a caller-supplied URL");
  assert.match(code, /await assertOwnedBlob\(input\.dealerSignatureUrl\)/, "prove it is ours first");
  assert.match(code, /readFile\(input\.dealerSignatureUrl\)/, "and read it through the guarded path");
});

test("the size cap is not mistaken for a private-store miss", () => {
  // The private branch swallows errors so it can fall back to the public path.
  // Swallowing the cap there would re-download the same oversized object.
  const code = src("src/lib/storage.ts");
  assert.match(code, /if \(error instanceof BlobTooLargeError\) throw error/);
});
