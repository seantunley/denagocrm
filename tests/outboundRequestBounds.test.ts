import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { configuredPdfImageHosts, pdfImageHostAllowed } from "../src/lib/pdfImageHosts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Two ways an outbound request goes wrong here.
 *
 * 1. It reaches somewhere it should not. The PDF renderer loads every
 *    subresource of an untrusted template, so an <img src> is a request the
 *    server makes on the author's behalf.
 * 2. It never comes back. Node's fetch has NO default timeout, so one
 *    unresponsive third party holds a webhook handler or a cron sweep open
 *    until the platform kills it.
 */

/**
 * The full argument list of every global `fetch(...)` call in `code`.
 *
 * Balanced-paren scanning, not a regex. A lazy `fetch\(([\s\S]*?)\)` stops at
 * the FIRST inner `)`, so `fetch(api(t, "sendMessage"), { …signal… })` yields
 * `api(t, "sendMessage"` and the signal is never seen — which reported four
 * already-correct call sites as unbounded when this test was first written.
 *
 * `\bfetch\(` would also match `client.fetch(...)` — imapflow's IMAP mailbox
 * read, which is not an HTTP request at all — so a preceding `.` disqualifies.
 */
function fetchCallArguments(code: string): string[] {
  const out: string[] = [];
  const re = /(^|[^.\w$])fetch\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    out.push(code.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

test("the fetch detector survives a nested call in the first argument", () => {
  // Guards the guard — the exact shape that produced four false positives.
  assert.deepEqual(fetchCallArguments(`await fetch(api(t, "x"), { signal: s })`), [`api(t, "x"), { signal: s }`]);
  assert.deepEqual(fetchCallArguments(`await client.fetch({ uid: true })`), [], "an IMAP .fetch is not an HTTP call");
  assert.deepEqual(fetchCallArguments(`fetch(url)`), ["url"]);
});

test("the PDF renderer's subresource guard is an allowlist, not a denylist", () => {
  // The old guard matched the HOSTNAME STRING against private ranges, and
  // Chromium resolves DNS afterwards — so a name that A-records to
  // 169.254.169.254 went straight through, as did metadata.google.internal.
  const code = shipped("src/lib/customDocs.ts");
  assert.doesNotMatch(code, /isBlockedHost/, "the denylist must be gone, not merely unused");
  assert.match(
    code,
    /if \(!pdfImageHostAllowed\(u\.hostname,[\s\S]{0,140}?\)\) return void r\.abort\(\)/,
    "the interceptor must consult the allowlist",
  );
  assert.match(code, /u\.protocol !== "https:" \|\| u\.username \|\| u\.password/, "https only, and no userinfo");
});

test("the old denylist could not have worked — the encodings it missed", () => {
  // Kept as an executable record of WHY the shape changed. Every string below is
  // 169.254.169.254 or a private address as far as Chromium is concerned, and
  // none of them matched. If someone proposes going back to a denylist, this is
  // the list they have to beat.
  const oldIsBlockedHost = (host: string): boolean => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    if (/^(0\.|::$|fc|fd)/.test(h)) return true;
    return false;
  };
  for (const missed of [
    "2852039166", // decimal
    "0xA9FEA9FE", // hex
    "0251.0376.0251.0376", // octal
    "[::ffff:169.254.169.254]", // IPv4-mapped IPv6
    "metadata.google.internal", // by name
    "rebind.evil.example", // resolves to 127.0.0.1
    "100.64.0.1", // carrier-grade NAT
    "fe80::1", // IPv6 link-local
  ]) {
    assert.equal(oldIsBlockedHost(missed), false, `${missed} was NOT blocked by the old guard`);
  }
  // …and it wrongly blocked a legitimate public host
  assert.equal(oldIsBlockedHost("fda.example.com"), true, "a public host beginning fd was a false positive");
});

test("every SERVER-SIDE outbound fetch is bounded", () => {
  // Node's fetch has no default timeout. A server-side call without a signal can
  // hang forever inside a request that has its own deadline — that is the
  // property this protects.
  //
  // Client components are deliberately out of scope. A fetch from the browser
  // holds nothing of ours open, the user can navigate away, and adding an
  // AbortSignal there changes UI behaviour rather than server exposure. Five
  // such calls exist (ClockWeather, LocationAutocomplete, SignSurface x2,
  // ApprovalSurface) and are left alone on purpose.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(entry)) out.push(rel);
    }
    return out;
  };

  // No exemptions. There WAS one for storage.ts, on the grounds that the
  // storage-ref PR bounded that read — it does not: it adds a streamed SIZE cap,
  // which is a different property. A size cap does nothing for a host that
  // accepts the connection and never sends a byte. An exemption resting on a
  // claim nobody re-checked is worse than no test, because it reads as coverage.
  const exempt = new Map<string, string>();

  const offenders: string[] = [];
  for (const file of walk("src")) {
    if (exempt.has(file)) continue;
    const raw = src(file);
    if (/^\s*["']use client["']/m.test(raw)) continue; // runs in the browser
    const code = shipped(file);
    for (const args of fetchCallArguments(code)) {
      if (/signal\s*:/.test(args)) continue;
      offenders.push(`${file}: fetch(${args.replace(/\s+/g, " ").slice(0, 80)})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these outbound requests have no timeout — add signal: AbortSignal.timeout(ms):\n  ${offenders.join("\n  ")}`,
  );
});

test("the blob read is bounded in TIME, not only in size", () => {
  // Review finding: the first version of this suite exempted storage.ts on the
  // grounds that the storage-ref PR bounded that read. It does not — it adds a
  // streamed SIZE cap, which says nothing about a host that accepts the
  // connection and then never sends a byte. Two different properties, and the
  // exemption quietly asserted the wrong one.
  const code = shipped("src/lib/storage.ts");
  assert.match(code, /const BLOB_FETCH_TIMEOUT_MS = \d/);
  assert.match(code, /fetch\(ref, \{ signal: AbortSignal\.timeout\(BLOB_FETCH_TIMEOUT_MS\) \}\)/);
});

test("only vouched hosts may be loaded while rendering a template", () => {
  for (const host of [
    "169.254.169.254",
    "2852039166",
    "metadata.google.internal",
    "rebind.evil.example",
    "evil.example",
    "blob.vercel-storage.com.evil.example",
    "127.0.0.1",
  ]) {
    assert.equal(pdfImageHostAllowed(host), false, `${host} must not be loadable`);
  }
  assert.equal(pdfImageHostAllowed("crm.denagocpt.co.za"), true, "our own origin");
  assert.equal(pdfImageHostAllowed("abc123.public.blob.vercel-storage.com"), true, "our blob store");
});

test("the PDF_IMAGE_HOSTS escape hatch cannot be pointed back inside", () => {
  // An allowlist is only as good as its config, and this is trusted config. The
  // entries below can only ever be a mistake, so they are dropped rather than
  // honoured — which does NOT remove the need for entries to be narrowly scoped.
  for (const bad of [
    "localhost",
    "cdn.internal",
    "assets.local",
    "10.0.0.5",
    "::1",
    "*",
    "*.example.com",
    "intranet", // single label
  ]) {
    assert.deepEqual(configuredPdfImageHosts(bad), [], `${bad} must be dropped`);
    assert.equal(pdfImageHostAllowed(bad.replace(/^\*\./, "a."), { configured: bad }), false);
  }
  // …while a genuine CDN entry works, including the suffix form
  assert.deepEqual(configuredPdfImageHosts("cdn.example.com, .assets.example.org"), [
    "cdn.example.com",
    ".assets.example.org",
  ]);
  assert.equal(pdfImageHostAllowed("cdn.example.com", { configured: "cdn.example.com" }), true);
  assert.equal(pdfImageHostAllowed("eu.assets.example.org", { configured: ".assets.example.org" }), true);
});

test("an inbound attachment is capped before it is in memory, not after", () => {
  // The 20MB cap was applied AFTER arrayBuffer(), i.e. once the whole response
  // was already resident. That is a report, not a cap.
  const code = shipped("src/lib/messenger.ts");
  assert.doesNotMatch(code, /Buffer\.from\(await res\.arrayBuffer\(\)\)/, "no unbounded buffering");
  assert.match(code, /const declared = Number\(res\.headers\.get\("content-length"/, "check the declared size first");
  assert.match(code, /if \(total > ATTACHMENT_MAX_BYTES\)/, "…and enforce it per chunk while reading");
  assert.match(code, /reader\.cancel\(\)/, "stop pulling once the cap is hit");
  const declaredAt = code.indexOf("const declared");
  const readAt = code.indexOf("res.body.getReader()");
  assert.ok(declaredAt !== -1 && readAt !== -1 && declaredAt < readAt, "the cheap check comes first");
});
