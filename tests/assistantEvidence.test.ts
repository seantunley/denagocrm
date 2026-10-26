import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import Module from "node:module";
import { lookupStatus, parseStep, planInstructions } from "../src/lib/crmAssistantPlan";

// crmAssistantEvidence reaches server-only + Prisma; its helpers are pure, so load it with server-only stubbed.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
};

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const evidence = () => import("../src/lib/crmAssistantEvidence");

test("the evidence lookups parse, and anything outside their schema is refused", () => {
  assert.deepEqual(parseStep('{"tool":"search_messages","args":{"customer":"Hendrik","words":"delivery transport","direction":"outbound","from":"2026-09-01"}}'), {
    tool: "search_messages", args: { customer: "Hendrik", words: "delivery transport", direction: "outbound", from: "2026-09-01" },
  });
  assert.equal(parseStep('{"tool":"search_messages","args":{"words":"delivery"}}'), null, "a customer is required — never a workspace-wide trawl");
  assert.equal(parseStep('{"tool":"search_messages","args":{"customer":"W","channel":"email; DROP"}}'), null);
  assert.equal(parseStep('{"tool":"search_messages","args":{"customer":"W","limit":50}}'), null);
  assert.deepEqual(parseStep('{"tool":"open_message","args":{"id":"cmabcdefghijklmnopqrstuv","thread":true}}'), {
    tool: "open_message", args: { id: "cmabcdefghijklmnopqrstuv", thread: true },
  });
  assert.equal(parseStep('{"tool":"open_message","args":{"id":"../../etc"}}'), null);
  assert.equal(parseStep('{"tool":"read_document","args":{"document":"contract","fromPage":21}}')?.tool, "read_document");
  assert.equal(parseStep('{"tool":"read_document","args":{"document":"x","path":"/etc/passwd"}}'), null, "strict: no extra arguments");
});

test("the planner is told when to use each, and the person sees what it is doing", () => {
  const plan = planInstructions({ today: "2026-10-26", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.match(plan, /- search_messages: .*"customer".*\(required\).*not by meaning/);
  assert.match(plan, /what did we promise/);
  assert.match(plan, /- open_message: .*"id".*\(required\)/);
  assert.match(plan, /- read_document: .*page numbers.*scanned PDF has no text/);
  assert.match(plan, /- documents: .*documentId/);
  assert.equal(lookupStatus([{ tool: "search_messages" }, { tool: "read_document" }]), "Searching their messages and reading a document…");
});

test("each is wired to its lookup, with its own character budget", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /case "search_messages": return searchMessages\(user, step\.args\);/);
  assert.match(lib, /case "open_message": return openMessage\(user, step\.args\);/);
  assert.match(lib, /case "read_document": return readDocument\(user, step\.args\);/);
  assert.match(lib, /const budget = OBSERVATION_BUDGET\[o\.tool\] \?\? OBSERVATION_CHARS;/);
  // The documents list hands read_document its id — and still never the file itself.
  assert.match(lib, /documentId: d\.id, file: d\.fileName/);
});

test("access: the helpers the pages use, the workspace named, nothing written, nothing logged but an error's name", () => {
  const src = code("src/lib/crmAssistantEvidence.ts");
  assert.match(src, /getAccessibleLeadIds\(user\)/);
  assert.match(src, /getAccessibleContactIds\(user\)/);
  assert.match(src, /getAccessibleDocumentIds\(user\)/);
  assert.match(src, /hasAnyPermission\(user, "documents\.view_all", "documents\.view_owned"\)/);
  assert.match(src, /canAccessContact\(user, row\.contactId\)/);
  // By id: the workspace is part of the lookup, not just trusted from RLS.
  assert.match(src, /communication\.findFirst\(\{ where: \{ id, tenantId \}/);
  assert.match(src, /"tenantId" = \$\{tenantId\}/);
  // The stored file is read the way /api/files reads it: checked against the RECORD's workspace.
  assert.match(src, /readFile\(doc\.storedName, doc\.tenantId\)/);
  assert.match(src, /isAutomotiveOwnedDocument/);
  // The id asked for is ANDed with the access list, never spread over it: `...{ id: x }` after
  // `...{ id: { in: ids } }` replaces the filter (it did, in read_document, until the real-DB test caught it).
  assert.doesNotMatch(src, /\.\.\.\((looksLikeId|ID\.test\(args\.document\))\s*\?\s*\{\s*id:/);
  assert.match(src, /AND: \[\s*\.\.\.\(docIds === null \? \[\] : \[\{ id: \{ in: docIds \} \}\]\)/);
  assert.match(src, /AND: \[\s*\.\.\.\(contactIds === null \? \[\] : \[\{ id: \{ in: contactIds \} \}\]\)/);
  // Read-only, and PDF text is never stored.
  assert.doesNotMatch(src, /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/);
  assert.doesNotMatch(src, /\$executeRaw/);
  for (const m of src.matchAll(/logError\(([^;]*)\);/g)) assert.match(m[1], /error instanceof Error \? error\.name : "unknown"/, "logs a name only");
});

test("the index migration and the query use the same expression, character for character", async () => {
  const { COMMUNICATION_SEARCH_DOC } = await evidence();
  const dir = new URL("../prisma/migrations/", import.meta.url);
  const migration = readdirSync(dir).find((d) => d.endsWith("_communication_search"));
  assert.ok(migration, "the communication_search migration exists");
  const sql = readFileSync(new URL(`${migration}/migration.sql`, dir), "utf8");
  assert.ok(sql.includes(`CREATE INDEX IF NOT EXISTS "Communication_search_idx"`));
  assert.ok(sql.includes(`USING GIN (to_tsvector('english', ${COMMUNICATION_SEARCH_DOC}))`), "index expression drifted from the query");
  // Additive only.
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/i);
  const src = code("src/lib/crmAssistantEvidence.ts");
  assert.match(src, /to_tsvector\('english', \$\{SEARCH_DOC\}\)/);
});

test("words become stems: 'delivery' and 'delivered' meet, stop words go, nothing unsafe survives", async () => {
  const { searchStems } = await evidence();
  assert.deepEqual(searchStems("What did we promise about delivery?"), ["promis", "deliv"]);
  // "deliver" is inside delivery, delivered and deliveries alike.
  assert.deepEqual(searchStems("delivered"), ["deliver"]);
  assert.deepEqual(searchStems("deposit R5,000 fee"), ["deposit", "000", "fee"]);
  assert.deepEqual(searchStems("%_' OR 1=1 --"), [], "only letters and digits — safe inside ILIKE");
  assert.equal(searchStems("a b c d e f g h i j k l m n o p q r s t u v w x y z alpha bravo charlie delta echo foxtrot golf hotel india").length, 8);
});

test("an excerpt is taken around the first word found", async () => {
  const { snippetAround } = await evidence();
  const text = `${"Hello and welcome. ".repeat(40)}We promise delivery in Paarl for R5,000. ${"More text. ".repeat(40)}`;
  const s = snippetAround(text, ["deliv"], 120);
  assert.match(s, /delivery in Paarl for R5,000/);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.equal(snippetAround("short one", ["zzz"]), "short one");
});

test("message facts: email is never 'delivered' or 'read'; WhatsApp says what WhatsApp reported", async () => {
  const { messageFacts } = await evidence();
  const at = new Date("2026-10-20T08:00:00Z");
  const email = { type: "email", direction: "outbound" };
  const said = [
    messageFacts({ ...email, openToken: "t".repeat(30), seenAt: at, openCount: 3 }).status!,
    messageFacts({ ...email, openToken: "t".repeat(30) }).status!,
    messageFacts({ ...email, messageId: "<x@y>" }).status!,
    messageFacts({ ...email }).status!,
    messageFacts({ ...email, messageId: "<x@y>", bouncedAt: at, bounceReason: null }).status!,
  ];
  assert.match(said[0], /^accepted by our mail server; open detected 2026-10-20 \(3×\)/);
  assert.match(said[1], /^accepted by our mail server; no open detected/);
  assert.match(said[2], /^accepted by our mail server; can't tell whether it was opened/);
  assert.match(said[3], /^recorded on the timeline only — can't tell whether it was sent/);
  assert.match(said[4], /^bounced 2026-10-20/);
  for (const s of said) assert.doesNotMatch(s, /delivered|\bread\b/i, s);
  assert.deepEqual(messageFacts({ type: "email", direction: "inbound" }), {});
  assert.match(messageFacts({ type: "whatsapp", direction: "outbound", deliveredAt: at }).status!, /whatsapp reports it reached their phone 2026-10-20/);
  assert.match(messageFacts({ type: "whatsapp", direction: "outbound", deliveredAt: at, seenAt: at }).status!, /reports it was read/);
  assert.match(messageFacts({ type: "messenger", direction: "outbound" }).status!, /no receipt from messenger/);
});

test("it tells people truthfully what it can now read — and what it still can't", async () => {
  const { selfKnowledge } = await import("../src/lib/assistantSoul");
  const about = selfKnowledge("DAX", new Set(["core", "automation"]));
  assert.match(about, /the text of a PDF among them with its page numbers \(not a scan/);
  assert.match(about, /every message to and from one customer, searched by words/);
  assert.match(about, /never whether it was read/);
  assert.match(about, /can't read scanned documents/);
  assert.match(about, /what you read in a document is not kept/);
  assert.doesNotMatch(about, /don't read the contents of documents/);
});
