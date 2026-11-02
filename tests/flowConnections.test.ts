import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectionAllows, connectionHost, parseConnections, secretLookingHeaders } from "../src/lib/flowConnections";
import { validateFlow } from "../src/lib/flowValidation";
import type { Flow } from "../src/lib/flow";

// Review 2026-11-02 (Sean's item 2): an API request step carried its API key in the flow — readable by anyone who
// edits flows, and copied into every published version.
test("a connection is locked to its own host — a flow edit can't send the key elsewhere", () => {
  assert.equal(connectionHost("https://api.sage.com/v1/"), "api.sage.com");
  assert.equal(connectionHost("API.Sage.com"), "api.sage.com");
  assert.equal(connectionHost("not a host"), null);
  assert.equal(connectionAllows({ host: "api.sage.com" }, "https://api.sage.com/v1/invoices"), true);
  assert.equal(connectionAllows({ host: "api.sage.com" }, "https://evil.example/?u=api.sage.com"), false);
  assert.equal(connectionAllows({ host: "api.sage.com" }, "https://api.sage.com.evil.example/"), false);
});

test("the saved list drops anything malformed", () => {
  const list = parseConnections(JSON.stringify([
    { id: "1", name: "Sage", host: "api.sage.com", headers: [{ name: "Authorization", value: "enc:v1:x" }, { name: "bad header!", value: "x" }] },
    { id: "2", name: "No host", host: "", headers: [] },
  ]));
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].headers.map((h) => h.name), ["Authorization"]);
  assert.deepEqual(parseConnections("not json"), []);
});

test("a key typed into a step's headers is warned about; ordinary headers are not", () => {
  assert.deepEqual(secretLookingHeaders('{"Authorization":"Bearer x","Accept":"application/json"}'), ["Authorization"]);
  assert.deepEqual(secretLookingHeaders('{"x-api-key":"k"}'), ["x-api-key"]);
  assert.deepEqual(secretLookingHeaders('{"Accept":"application/json"}'), []);
  const flow: Flow = { start: "h", nodes: { h: { id: "h", type: "http", method: "GET", url: "https://api.sage.com/x", headers: '{"Authorization":"Bearer k"}', next: "e", failureNext: "e" }, e: { id: "e", type: "end" } } };
  assert.ok(validateFlow(flow).some((i) => i.code === "http.secret_header" && i.severity === "warning"));
});

test("send time: decrypted only then, only for the connection's host, never shown on a page or written to the audit", () => {
  const tools = readFileSync("src/lib/flowRuntimeTools.ts", "utf8");
  assert.match(tools, /const connection = await connectionHeaders\(input\.connectionId, url\.toString\(\)\);\s*if \(!connection\.ok\) return \{ ok: false, reason: connection\.reason \};/);
  const server = readFileSync("src/lib/flowConnectionsServer.ts", "utf8");
  assert.match(server, /if \(!connectionAllows\(connection, url\)\) return \{ ok: false/);
  const actions = readFileSync("src/app/actions/flowConnections.ts", "utf8");
  assert.match(actions, /headers\.push\(\{ name: header, value: encryptValue\(value\.trim\(\)\) \}\)/);
  assert.match(actions, /headers: \$\{headers\.map\(\(h\) => h\.name\)\.join\(", "\)\}/, "the audit names headers, never values");
  const page = readFileSync("src/app/(app)/bot-builder/[id]/page.tsx", "utf8");
  assert.match(page, /\.map\(\(\{ id, name, host \}\) => \(\{ id, name, host \}\)\)/, "the builder page never gets a key");
});
