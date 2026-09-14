import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import {
  isPrivateIp,
  isBlockedHost,
  validateUrl,
  assertResolvesPublic,
  makePinnedLookup,
  pinnedAgent,
} from "../src/lib/ssrfGuard";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The outbound SSRF guard had NO test. It is the one place in the app that uses
 * undici directly, and what it uses is `Agent`'s custom `connect.lookup` hook —
 * a contract a major bump can change without changing a type, so the app would
 * still compile, still build, and quietly connect to whatever DNS returned.
 *
 * These tests therefore go through REAL undici and REAL DNS rather than stubbing
 * either. Nothing here reaches the public internet: every connection is to a
 * loopback server started by the test.
 */

/** A throwaway HTTP server on 127.0.0.1, torn down by the caller. */
async function loopbackServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("isPrivateIp refuses every private, reserved and encoded-loopback form", () => {
  const blocked = [
    "127.0.0.1", "127.1", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254",              // AWS/GCP metadata
    "100.64.0.1",                                   // CGNAT
    "::1", "fe80::1", "fc00::1", "fd00::1",         // v6 loopback / link-local / unique-local
    "::ffff:127.0.0.1",                             // v4-mapped, dotted
    "::ffff:7f00:1",                                // v4-mapped, hex — the form a denylist misses
    "::ffff:169.254.169.254",
    "2002:a9fe:a9fe::1",                            // 6to4 wrapping metadata
    "2001:0::1",                                    // Teredo
    "224.0.0.1",                                    // multicast
    "not-an-ip", "", "999.999.999.999",             // unparseable → refuse
  ];
  for (const ip of blocked) assert.equal(isPrivateIp(ip), true, `${ip} must be refused`);

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
  for (const ip of allowed) assert.equal(isPrivateIp(ip), false, `${ip} must be allowed`);
});

test("isBlockedHost refuses internal names before any DNS", () => {
  for (const host of [
    "localhost", "app.localhost", "LOCALHOST",
    "printer.local", "db.internal", "metadata.google.internal", "metadata",
    "nas.lan", "", "127.0.0.1", "[::1]", "169.254.169.254",
  ]) {
    assert.equal(isBlockedHost(host), true, `${host} must be blocked`);
  }
  // Must NOT over-block: a public name that merely CONTAINS a blocked substring.
  for (const host of ["example.com", "localhost.example.com", "internal.example.com", "local.example.com"]) {
    assert.equal(isBlockedHost(host), false, `${host} must be allowed`);
  }
});

test("validateUrl enforces protocol, port and host before a socket exists", () => {
  for (const [url, why] of [
    ["file:///etc/passwd", "protocol"],
    ["ftp://example.com/x", "protocol"],
    ["gopher://example.com/", "protocol"],
    ["http://example.com:22/", "port"],
    ["http://example.com:6379/", "port"],
    ["http://localhost/", "host"],
    ["http://169.254.169.254/latest/meta-data/", "host"],
    ["http://[::ffff:127.0.0.1]/", "host"],
    ["http://metadata.google.internal/", "host"],
    ["not a url", "parse"],
  ] as const) {
    assert.throws(() => validateUrl(url), `${url} must be refused (${why})`);
  }
  for (const url of ["http://example.com/", "https://example.com:443/a?b=1"]) {
    assert.ok(validateUrl(url) instanceof URL, `${url} must be accepted`);
  }
});

test("assertResolvesPublic refuses a name that resolves to loopback", async () => {
  // Real DNS. "localhost" resolves to 127.0.0.1/::1 on every machine, which is
  // what makes this deterministic without a network.
  await assert.rejects(() => assertResolvesPublic("localhost"), /private|no addresses/i);
  await assert.rejects(() => assertResolvesPublic("127.0.0.1"), /private|reserved/i);
});

test("the pinned lookup blocks a host that resolves only to private addresses", async () => {
  // This is the function undici calls at connect time. Driving it directly
  // proves the filter, independently of whether undici still honours it.
  const lookup = makePinnedLookup();
  const err = await new Promise<Error | null>((resolve) => {
    lookup("localhost", { all: true }, (e) => resolve(e));
  });
  assert.ok(err, "localhost must not survive the pinned lookup");
  assert.match(err.message, /private/i);
});

test("undici still honours a custom connect.lookup", async () => {
  // The control. If a version bump made undici ignore `connect.lookup`, or
  // changed its signature so ours always errored, the test below would pass for
  // entirely the wrong reason. This proves a custom lookup IS called and that
  // the address it returns is the one connected to.
  const server = await loopbackServer();
  try {
    let called = false;
    const permissive = new Agent({
      connect: {
        lookup: makePinnedLookup(() => {
          called = true;
          return true; // allow loopback, for this control only
        }),
      },
    });
    // undici's fetch, matching production (lib/safeFetch.ts). Pairing an npm
    // undici Agent with Node's GLOBAL fetch pairs two different copies of
    // undici, which is the failure described on the test below.
    const res = await undiciFetch(`http://localhost:${server.port}/`, {
      dispatcher: permissive,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.ok(called, "undici must call the custom lookup");
    await permissive.close();
  } finally {
    await server.close();
  }
});

test("the real pinnedAgent refuses to connect to loopback, for the right reason", async () => {
  // End to end, through real undici: our filter must actually stop the socket.
  //
  // The `cause` assertion is the point. A bare "it rejected" would pass even
  // when the dispatcher is not working AT ALL — which is exactly what happened
  // on undici 8 while this used Node's GLOBAL fetch: it rejected a v8 Agent with
  // "invalid onRequestStart method" before our lookup was ever consulted. A
  // guard test that cannot tell "we blocked it" from "the plumbing is broken" is
  // worse than no test, because it reports green while the guard is inert.
  //
  // That is also why the fix was to move production onto undici's own fetch
  // rather than to relax this assertion — the assertion was right.
  const server = await loopbackServer();
  try {
    const error = await undiciFetch(`http://localhost:${server.port}/`, {
      dispatcher: pinnedAgent,
    }).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    assert.ok(error, "a loopback connection must be refused by the pinned agent");
    assert.match(
      error.cause?.message ?? error.message,
      /Blocked: host resolves only to private addresses/,
      "the refusal must come from OUR lookup, not from a broken dispatcher",
    );
  } finally {
    await server.close();
  }
});

test("safeFetch still routes every request through the pinned dispatcher", () => {
  // The guard is only as good as its being attached. A fetch in this file
  // without `dispatcher: pinnedAgent` would silently bypass the connect-time
  // check and leave only the pre-flight one, reopening the rebinding window.
  const code = read("src/lib/safeFetch.ts");
  /*
   * No `\b`, and case-insensitive, so this counts `undiciFetch(` too. The old
   * `/\bfetch\(/` counted ZERO once production moved to undici's fetch: there is
   * no word boundary between the `i` and the `F` of `undiciFetch`. An exact-count
   * assertion is what caught that — a "no unguarded fetch" assertion would have
   * gone green by matching nothing at all.
   */
  const fetches = [...code.matchAll(/fetch\(/gi)];
  assert.equal(fetches.length, 1, "expected exactly one fetch in safeFetch");
  // …and it must be undici's, or the dispatcher below is silently inert.
  assert.match(code, /await undiciFetch\(/, "the request must go through undici's own fetch");
  assert.doesNotMatch(
    code,
    /await fetch\(/,
    "Node's global fetch cannot drive an npm-undici Agent — see the comment in safeFetch",
  );
  assert.match(code, /dispatcher: pinnedAgent/);
  assert.match(code, /redirect: "manual"/, "redirects must stay manually validated");
  assert.match(code, /await assertResolvesPublic\(u\.hostname\)/);
  assert.match(code, /signal: AbortSignal\.timeout/, "an outbound fetch must be bounded");
});

test("THE FLOWBOT HTTP TOOL IS GUARDED THE SAME WAY — and was untested until now", () => {
  /*
   * lib/flowRuntimeTools.ts runs arbitrary author-supplied URLs from a chatbot
   * flow, which makes it the most exposed outbound fetch in the app. It got its
   * own connect-time re-check (`guardedDispatcher`) in #616 and NO test — so the
   * undici-8 swap that broke lib/safeFetch would have broken this silently.
   *
   * Source-level, deliberately: driving the real thing needs a flow runtime, a
   * database and a live socket. What can regress here is the WIRING — the pair
   * coming apart — and that is exactly what source can see.
   */
  const code = read("src/lib/flowRuntimeTools.ts");
  assert.match(code, /await undiciFetch\(url,/, "the outbound call must use undici's own fetch");
  assert.match(code, /dispatcher: guardedDispatcher/, "…with the connect-time guard attached");
  // Both halves must come from ONE undici, which is the whole lesson of the v8
  // break: a global-fetch call here would reject the Agent before it is asked.
  assert.match(code, /import \{ Agent, fetch as undiciFetch \} from "undici"/);
  assert.match(code, /redirect: "error"/, "a redirect must not escape the vetted address");
});

test("the guard carries no server-only marker, so it stays testable", () => {
  // The reason this file exists. safeFetch.ts keeps the marker; the policy does
  // not, or none of the above could run.
  assert.doesNotMatch(read("src/lib/ssrfGuard.ts"), /^import "server-only"/m);
  assert.match(read("src/lib/safeFetch.ts"), /^import "server-only"/m);
});
