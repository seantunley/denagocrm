import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_GENUINE } from "../src/lib/signing/verifyVerdict";

/**
 * The public "is this the document that was signed?" page.
 *
 * It is reachable by anyone, so what matters is what it takes and what it gives
 * back: a fingerprint in, and nothing out that the holder of the file does not
 * already have. The database half is scripts/test-signing-verify.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the page and its endpoint are reachable without an account — and nothing else was opened", () => {
  const proxy = shipped("src/proxy.ts");
  const list = proxy.slice(proxy.indexOf("const PUBLIC_PATHS"), proxy.indexOf("];", proxy.indexOf("const PUBLIC_PATHS")));
  const paths = [...list.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(paths.includes("/verify") && paths.includes("/api/verify"));
  // A prefix match, so "/verify" must not swallow anything that needs a session.
  const opened = (target: string) => paths.some((p) => target === p || target.startsWith(`${p}/`));
  assert.ok(opened("/verify") && opened("/api/verify"));
  for (const staffOnly of ["/verification", "/api/verify-something", "/signatures", "/api/signatures/x/evidence", "/api/files/x"]) {
    assert.equal(opened(staffOnly), false, `${staffOnly} must still need a session`);
  }
});

test("the file is fingerprinted in the browser and only the fingerprint is sent", () => {
  const client = shipped("src/app/verify/VerifyDocument.tsx");
  assert.match(client, /crypto\.subtle\.digest\("SHA-256", await file\.arrayBuffer\(\)\)/);
  assert.match(client, /body: JSON\.stringify\(\{ sha256 \}\)/);
  assert.doesNotMatch(client, /FormData|multipart|readAsDataURL|btoa\(/, "the file itself must never be put in a request");
  assert.equal(client.match(/fetch\(/g)?.length, 1, "one request, and it is the fingerprint");
  // The page says so, in the visitor's words — and it has to be true.
  assert.match(read("src/app/verify/VerifyDocument.tsx"), /The file stays on your device\. Only its fingerprint/);
});

test("a client component takes the verdict's shape from a file with no server code behind it", () => {
  // Importing even a TYPE from a module that reaches the database pulls that
  // module towards the browser bundle. The shape lives on its own for that.
  const client = shipped("src/app/verify/VerifyDocument.tsx");
  assert.match(client, /import type \{ DocumentVerdict \} from "@\/lib\/signing\/verifyVerdict"/);
  assert.doesNotMatch(client, /from "@\/lib\/signing\/verifyDocument"|from "@\/lib\/db"|server-only/);
  assert.doesNotMatch(shipped("src/lib/signing/verifyVerdict.ts"), /\bimport\b/, "the verdict's file must import nothing");
  assert.deepEqual(NOT_GENUINE, { genuine: false });
});

test("the endpoint is throttled before it looks anything up, and accepts a fingerprint and nothing else", () => {
  const route = shipped("src/app/api/verify/route.ts");
  const throttle = route.indexOf('throttlePublic("verify-document", null, DOCUMENT_VERIFY_POLICY)');
  const lookup = route.indexOf("verifySealedDocument(");
  assert.ok(throttle > 0 && lookup > throttle, "the throttle comes first");
  // By address only: the fingerprint is the caller's to invent, and a limit keyed
  // on it would let anyone mint a row per made-up value.
  assert.match(route, /throttlePublic\("verify-document", null,/);
  assert.match(route, /z\.object\(\{ sha256: z\.string\(\)\.regex\(\/\^\[0-9a-fA-F\]\{64\}\$\/\) \}\)\.strict\(\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /export async function GET/, "nothing to fetch by address — the fingerprint goes in a body");
  const policy = shipped("src/lib/rateLimit.ts");
  assert.match(policy, /export const DOCUMENT_VERIFY_POLICY: RateLimitPolicy = \{\s*limit: 30,/);
});

test("a match needs BOTH records to agree, and anything else is the same 'no match'", () => {
  const verify = shipped("src/lib/signing/verifyDocument.ts");
  // The custody row finds the workspace; the request must be completed WITH this file.
  assert.match(verify, /if \(!sealed\) return NOT_GENUINE;/);
  assert.match(verify, /where: \{ id: sealed\.requestId, tenantId: sealed\.tenantId \}/, "the workspace is the one the custody row names, named on the read");
  assert.match(verify, /if \(!request \|\| request\.status !== "completed" \|\| request\.signedPdfHash !== digest \|\| !request\.completedAt\) return NOT_GENUINE;/);
  // What a match gives back: nothing that names a person or an address.
  const answer = verify.slice(verify.lastIndexOf("return {"), verify.lastIndexOf("};"));
  assert.deepEqual(
    [...answer.matchAll(/^\s{6}(\w+)[:,]/gm)].map((m) => m[1]).sort(),
    ["genuine", "sealedAt", "sealedBy", "signers", "timeZone", "timestamped", "title"],
  );
  assert.doesNotMatch(answer, /email|phone|name:|signedName|signerIp|contactId|recipientId/);
  assert.match(verify, /timestamped: Boolean\(request\.timestampToken\) && verifyTimestampToken\(/, "'time-stamped' is checked, not read from a column");

  const resolver = shipped("src/lib/tokenTenant.ts");
  const body = resolver.slice(resolver.indexOf("export async function resolveSealedDocument"));
  assert.match(body, /if \(!\/\^\[0-9a-f\]\{64\}\$\/\.test\(sha256\)\) return null;[\s\S]*?basePrisma\.legalArtifact\.findFirst/, "nothing but a digest reaches the query");
});

test("every newly sealed document tells its holder where to check it — on the workspace's own address", () => {
  const complete = shipped("src/lib/signing/complete.ts");
  assert.match(complete, /verifyNoticeHtml\(await tenantOrigin\(req\.tenantId\)\)/);
  const start = complete.indexOf("function verifyNoticeHtml");
  const notice = complete.slice(start, complete.indexOf("\n}", start));
  assert.match(notice, /To check that a copy of this document is genuine and unchanged, go to <strong>\$\{esc\(origin\)\}\/verify<\/strong> and choose the file\./);
  // Inside the sealed bytes: after the certificate, before anything is rendered to PDF.
  assert.ok(complete.indexOf("verifyNoticeHtml(await tenantOrigin") < complete.indexOf("await htmlToPdf(html)"));
});

test("the page takes its brand from the address it was opened on, and names no workspace until a file matches", () => {
  const page = shipped("src/app/verify/page.tsx");
  assert.match(page, /const brand = await loginBrand\(\);/);
  assert.match(page, /robots: \{ index: false \}/);
  assert.doesNotMatch(page, /getCurrentUser|requireUser|prisma/, "no session, and no database read to draw the page");
});
