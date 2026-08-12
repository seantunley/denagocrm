import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  BlobNotYoursError,
  assertOwnedBlob,
  readFile,
  saveFile,
} from "../src/lib/storage";

/**
 * Finishing the tenant namespacing of blob uploads.
 *
 * #474 gave `saveFile` an optional owner and taught `assertOwnedBlob` to ask "is
 * this YOURS?" instead of only "is this OURS?" — then wired exactly one caller,
 * the library registration path, and said so. Every other upload still wrote to
 * the flat `uploads/<uuid>` prefix, so the ownership question had nothing to read
 * on twenty-two of twenty-three write sites and the check silently degraded to
 * the legacy branch: "belongs to the founding tenant".
 *
 * Two claims are proven here, both against the REAL functions rather than a
 * restatement of them:
 *
 *   1. a new upload lands under its owner's prefix, and
 *   2. a ref from another workspace is refused.
 *
 * …plus the one that decides whether this is shippable at all: everything already
 * in the bucket sits at a flat path and must keep resolving.
 *
 * HOW. `@vercel/blob` takes its API base from `VERCEL_BLOB_API_URL`, so the SDK
 * runs for real against a local stub that records what it was asked to write and
 * answers `head()` with whatever pathname the test wants. That is deliberately
 * not a mock of our own code: the thing worth proving is what the STORE ends up
 * holding, and a stub of `put` would prove only that we called our own helper.
 */

/* ------------------------------------------------------- the stubbed store */

const STORE_HOST = "teststore.public.blob.vercel-storage.com";
const objectUrl = (pathname: string) => `https://${STORE_HOST}/${pathname}`;

/** Every pathname the SDK was asked to write, in order. */
const written: string[] = [];
/** What `head()` should answer for a given object URL. */
const headPathname = new Map<string, string>();
/** Bytes a public object fetch should return. */
const objectBytes = new Map<string, Buffer>();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const write = url.searchParams.get("pathname");
  const lookup = url.searchParams.get("url");
  res.setHeader("content-type", "application/json");

  if (write !== null) {
    written.push(write);
    // Drain the body so the SDK's request completes.
    req.resume();
    req.on("end", () => {
      res.end(
        JSON.stringify({
          url: objectUrl(write),
          downloadUrl: objectUrl(write),
          pathname: write,
          contentType: "application/octet-stream",
          contentDisposition: "inline",
        }),
      );
    });
    return;
  }

  if (lookup !== null) {
    const pathname = headPathname.get(lookup);
    if (pathname === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "blob_not_found" } }));
      return;
    }
    res.end(
      JSON.stringify({
        url: lookup,
        downloadUrl: lookup,
        pathname,
        size: objectBytes.get(lookup)?.length ?? 0,
        contentType: "application/octet-stream",
        contentDisposition: "inline",
        cacheControl: "public",
        uploadedAt: new Date().toISOString(),
      }),
    );
    return;
  }

  res.statusCode = 400;
  res.end(JSON.stringify({ error: { code: "bad_request" } }));
});

const realFetch = globalThis.fetch;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${port}`;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_TESTSTORE_abcdefghijklmnop";
  delete process.env.BLOB_PRIVATE;
  delete process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;

  /**
   * `readFile`'s public branch fetches the object itself, from a host that does
   * not exist. Route THAT one call — the SDK talks to the stub server over its
   * own client and is unaffected.
   */
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bytes = objectBytes.get(target);
    if (bytes) return new Response(new Uint8Array(bytes), { status: 200 });
    return realFetch(input as Parameters<typeof realFetch>[0], init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

/** Register an object the stub store will acknowledge and serve. */
function publish(pathname: string, body = "bytes"): string {
  const url = objectUrl(pathname);
  headPathname.set(url, pathname);
  objectBytes.set(url, Buffer.from(body));
  return url;
}

const A = "tenant_a";
const B = "tenant_b";
const FOUNDING = "tenant_denago_cpt"; // DEFAULT_TENANT_ID

/* ----------------------------------------------- 1. the write is namespaced */

test("a new upload lands under its owner's prefix", async () => {
  written.length = 0;
  const url = await saveFile(Buffer.from("photo"), "checkin.JPG", "image/jpeg", A);

  assert.equal(written.length, 1, "exactly one object should have been written");
  const pathname = written[0];
  assert.match(
    pathname,
    new RegExp(`^uploads/${A}/[0-9a-f-]{36}\\.JPG$`),
    `expected uploads/${A}/<uuid>.JPG, got ${pathname}`,
  );
  // The store's own pathname is the ownership claim — not the caller's word for it.
  assert.equal(url, objectUrl(pathname));
});

test("an upload with no owner keeps the legacy flat path", async () => {
  // Not a shrug: a parent row written before stamping is genuinely unowned, and
  // substituting a workspace for its NULL is the defect #463 removed. The flat
  // path is where this object lands today, so nothing moves.
  written.length = 0;
  await saveFile(Buffer.from("photo"), "scan.pdf", "application/pdf", null);
  assert.match(written[0], /^uploads\/[0-9a-f-]{36}\.pdf$/);
  assert.ok(!written[0].startsWith("uploads/null/"), "a null owner must not become a path segment");

  written.length = 0;
  await saveFile(Buffer.from("photo"), "scan.pdf", "application/pdf");
  assert.match(written[0], /^uploads\/[0-9a-f-]{36}\.pdf$/, "an omitted owner behaves as before");
});

/* ------------------------------------------- 2. another workspace is refused */

test("a ref from another workspace is refused, on both halves of the round trip", async () => {
  written.length = 0;
  const url = await saveFile(Buffer.from("contract"), "quote.pdf", "application/pdf", A);
  publish(written[0]);

  // The owner reads it.
  const owned = await assertOwnedBlob(url, A);
  assert.equal(owned.pathname, written[0]);
  assert.deepEqual(await readFile(url, A), Buffer.from("bytes"));

  // Workspace B holds the URL — forwarded, pasted, screenshotted, whatever — and
  // gets a verdict rather than bytes. This is the exact move #474 named: nothing
  // forged, nothing guessed, the URL is the only secret.
  await assert.rejects(() => assertOwnedBlob(url, B), BlobNotYoursError);
  await assert.rejects(() => readFile(url, B), BlobNotYoursError);

  // …and not even the founding tenant, whose claim on a LEGACY object is total.
  await assert.rejects(() => readFile(url, FOUNDING), BlobNotYoursError);
});

test("a cross-workspace refusal is reported as a refusal, not as 'not in our store'", async () => {
  // The two-store retry loop swallows misses. If it swallowed this too, the
  // attempt would surface as "not ours" — misleading, and it hides that someone
  // tried. Assert on the TYPE, because that is what the callers can branch on.
  written.length = 0;
  const url = await saveFile(Buffer.from("x"), "a.png", "image/png", A);
  publish(written[0]);
  const error = await assertOwnedBlob(url, B).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(error instanceof BlobNotYoursError, `expected BlobNotYoursError, got ${String(error)}`);
});

test("the private store is checked too, and is never asked for the bytes", async () => {
  // readFile's private branch returns bytes WITHOUT reaching assertOwnedBlob —
  // reaching that store proves the STORE, which is the exact distinction #474 was
  // about. So the refusal has to happen in THAT branch as well.
  //
  // Asserting only that the call rejects would prove nothing: with the check
  // deleted, the private read misses, falls through to the public branch, and is
  // refused there — same error, same colour, mutation survives. What actually
  // distinguishes the two is whether the private store was CONTACTED at all, so
  // that is what this measures.
  const previousDispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  // The stub API server is still needed for head(); only the private store host
  // is being watched.
  agent.enableNetConnect(/127\.0\.0\.1/);
  setGlobalDispatcher(agent);

  const privateHost = "https://teststore.private.blob.vercel-storage.com";
  const privateReads: string[] = [];
  agent
    .get(privateHost)
    .intercept({ path: /.*/, method: "GET" })
    .reply((options: { path: string }) => {
      // Counted BY THE INTERCEPTOR, so the number reflects what left the process
      // rather than what the test believed it did.
      privateReads.push(options.path);
      return { statusCode: 200, data: "private bytes" };
    })
    .times(4);

  process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = "vercel_blob_rw_TESTSTORE_privatetoken";
  try {
    const pathname = `uploads/${A}/private-object.pdf`;
    const url = publish(pathname);
    // The private store is reachable and the branch is live: the OWNER gets the
    // private store's bytes, not the public stub's. Without this the "never
    // contacted" assertion below would pass for the wrong reason.
    const mine = await readFile(url, A);
    assert.equal(mine.toString(), "private bytes", "the owner should be served from the private store");
    assert.equal(privateReads.length, 1, "the private branch must actually be exercised");

    await assert.rejects(() => readFile(url, B), BlobNotYoursError);
    assert.deepEqual(
      privateReads.length,
      1,
      `a foreign ref must be refused BEFORE the private store is asked for the object (it was asked for ${privateReads.slice(1).join(", ")})`,
    );
  } finally {
    delete process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
  }
});

/* --------------------------------------------- 3. nothing already stored moves */

test("legacy flat objects keep resolving for the founding tenant", async () => {
  // The whole bucket is at flat paths today. If this goes red, every existing
  // download is broken and the change is not shippable — which is why it is
  // asserted through readFile end-to-end, not through the predicate alone.
  const url = publish("uploads/legacy-invoice.pdf", "legacy bytes");

  assert.deepEqual(await readFile(url, FOUNDING), Buffer.from("legacy bytes"));
  // …and an unowned record, which is most of production, asserts nothing at all.
  assert.deepEqual(await readFile(url, null), Buffer.from("legacy bytes"));
  assert.deepEqual(await readFile(url), Buffer.from("legacy bytes"));
  // A legacy object still belongs to exactly one workspace.
  await assert.rejects(() => readFile(url, A), BlobNotYoursError);
});

/* --------------------------------------------------------------- the sweep */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip comments and string bodies so a `saveFile(` inside prose is not a call. */
function stripNoise(code: string): string {
  return code
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([^\n"'`]*?)\/\/.*$/gm, "$1");
}

/**
 * Count the top-level arguments of the call starting at `open` (the index of the
 * `(`). Deliberately a real scan rather than a regex: several of these call sites
 * pass template literals containing commas and parentheses, and a regex that
 * "mostly works" on them would fail open — which for this particular test means
 * silently passing a call site that never got its owner.
 */
function argumentCount(code: string, open: number): number {
  let depth = 0;
  let args = 1;
  let quote: string | null = null;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      else if (quote === "`" && ch === "$" && code[i + 1] === "{") {
        // A template substitution is code again; treat it as a nesting level.
        const close = matchBrace(code, i + 1);
        if (close === -1) return args;
        i = close;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return args;
    } else if (ch === "," && depth === 1) args += 1;
  }
  return args;
}

function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Sites that deliberately do NOT name an owner, each with the reason. Empty on
 * purpose: every upload path in the application has a parent record, an acting
 * workspace, or a resolved channel. The list exists so that adding one is a
 * decision somebody writes down, rather than an argument quietly left off.
 */
const UNOWNED_BY_DESIGN: Array<{ file: string; why: string }> = [];

test("every saveFile call site in src/ names an owner", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (rel === "src/lib/storage.ts") continue; // the declaration itself
    if (UNOWNED_BY_DESIGN.some((exempt) => exempt.file === rel)) continue;
    const code = stripNoise(readFileSync(file, "utf8"));
    const pattern = /(?<![.\w])saveFile\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      const open = match.index + match[0].length - 1;
      const count = argumentCount(code, open);
      if (count < 4) {
        const line = code.slice(0, match.index).split("\n").length;
        offenders.push(`${rel}:${line} — ${count} arguments, no owner`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these uploads still write to the un-namespaced prefix, so nothing can later ask who they belong to:\n  ${offenders.join("\n  ")}`,
  );
});

test("the sweep can actually see a missing owner", () => {
  // A guard that cannot fail is not a guard. Prove the argument counter against
  // the shapes these call sites really use — template literals with commas and
  // nested calls in them are exactly where a regex-based version failed open.
  const three = `saveFile(buf, \`photo-\${a}, \${b}.png\`, file.type)`;
  const four = `saveFile(buf, \`photo-\${a}, \${b}.png\`, file.type, jobCard.tenantId)`;
  assert.equal(argumentCount(three, three.indexOf("(")), 3);
  assert.equal(argumentCount(four, four.indexOf("(")), 4);
  const nested = `saveFile(buf, name, type, await customerRecordTenantId({ contactId, leadId }))`;
  assert.equal(argumentCount(nested, nested.indexOf("(")), 4);
});
