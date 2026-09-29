import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/**
 * Two facts about /api/photos/upload that are true only together, in two files
 * that nothing else connects.
 *
 * The route serves two events. `blob.generate-client-token` comes from the
 * browser and carries the staff session. `blob.upload-completed` is a
 * server-to-server callback from Vercel Blob — no browser, no cookie — and the
 * proxy 401s every unauthenticated request that is not in PUBLIC_PATHS. So the
 * callback was refused before the route saw it, and nothing said so: the browser
 * upload still succeeds, the person sees photos appear, and only the callback
 * quietly never runs. Anyone who later puts real work in onUploadCompleted
 * inherits a handler that cannot fire.
 */

const PATH = "/api/photos/upload";

test("the route that answers the blob callback is reachable without a session", () => {
  const route = src("src/app/api/photos/upload/route.ts");
  assert.match(route, /onUploadCompleted:/, "no callback registered — this test guards the wrong thing now");

  const proxy = src("src/proxy.ts");
  const list = proxy.slice(proxy.indexOf("const PUBLIC_PATHS"), proxy.indexOf("PUBLIC_PATHS.some("));
  assert.ok(
    list.includes(`"${PATH}"`),
    `${PATH} registers onUploadCompleted but is not in PUBLIC_PATHS, so the proxy 401s Vercel's callback before the route runs`,
  );
});

/*
 * …and the reason that entry is safe. It relaxes the proxy for BOTH events, so
 * the token branch has to hold the line by itself: refuse when there is no
 * session, and re-check the specific record before minting a token that grants
 * write access to a path.
 */
test("being public costs the token branch nothing — it authorises for itself", () => {
  const route = src("src/app/api/photos/upload/route.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(route, /photoUploadNeedsStaffSession\(body\?\.type\)/, "the two events must still be told apart");
  assert.match(route, /tenantId = await actingTenantId\(\)/, "actingTenantId throws with no session — that is the refusal");
  assert.match(route, /if \(!tenantId\) throw new Error/, "and the token mint must not proceed without one");

  // The record checks must run BEFORE the token is returned, not merely appear
  // somewhere in the file.
  const mint = route.slice(route.indexOf("onBeforeGenerateToken"), route.indexOf("onUploadCompleted"));
  assert.match(mint, /requireQuoteAccess\(target\.recordId, "deliveries\.manage"\)/);
  assert.match(mint, /requireJobCardAccess\(/);
  assert.ok(
    mint.indexOf("requireQuoteAccess") < mint.indexOf("return {"),
    "the permission check must precede the token payload it authorises",
  );
  assert.match(mint, /if \(!pathname\.startsWith\(prefix\)\)/, "the granted path must be pinned to tenant and record");
});

test("the callback trusts its signature, never the request's identity", () => {
  const route = src("src/app/api/photos/upload/route.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
  const completed = route.slice(route.indexOf("onUploadCompleted"));

  // handleUpload verifies x-vercel-signature before this handler runs. Reading
  // ownership from tokenPayload rather than a session is what makes that work —
  // there is no session on the callback to read.
  assert.match(completed, /parseCompletionOwnership\(tokenPayload\)/);
  assert.doesNotMatch(completed, /actingTenantId|requireUser|getCurrentUser/, "the callback has no session to check");
});

/*
 * Being in PUBLIC_PATHS has a cost the token branch must also pay: an anonymous
 * caller reaches this route, and every failure here writes a persistent ErrorLog
 * row. Unbounded, from the open internet, that is a log-flooding primitive — the
 * System Log fills with rows nobody can attribute and real failures are buried.
 */
test("an unidentified caller is refused before anything is written", () => {
  const route = src("src/app/api/photos/upload/route.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

  // Both refusals must come BEFORE the handleUpload call whose catch logs, or
  // the anonymous request is still recorded on its way out.
  const gate = route.lastIndexOf('return NextResponse.json({ error: "Unauthorized" }, { status: 401 })');
  const work = route.indexOf("const response = await handleUpload(");
  assert.notEqual(gate, -1, "an anonymous caller must be refused with 401");
  assert.notEqual(work, -1, "handleUpload not found — has the route been restructured?");
  assert.ok(gate < work, "the refusals must precede the work whose catch writes the log row");

  assert.match(route, /catch \{\s*return NextResponse\.json\(\{ error: "Unauthorized" \}/, "a thrown actingTenantId must refuse, not fall through to the logger");
  assert.match(route, /!request\.headers\.get\("x-vercel-signature"\)/, "an unsigned callback must be refused before handleUpload logs it");
});

test("only an identified caller can write to the System Log", () => {
  const route = src("src/app/api/photos/upload/route.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
  const tail = route.slice(route.lastIndexOf("} catch (error) {"));

  assert.match(tail, /if \(tenantId\) \{/, "the persistent write must be conditional on having a tenant");
  const guard = tail.indexOf("if (tenantId)");
  const write = tail.indexOf("logError(");
  assert.ok(guard !== -1 && guard < write, "logError must sit inside the tenant guard");
  assert.match(tail, /console\.error\(/, "an unattributable failure still needs to go somewhere that rotates");
});
