import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { visibleAnswer } from "../src/lib/assistantStream";
import { isSameOrigin } from "../src/lib/sameOrigin";
import { parseCodexStream } from "../src/lib/codexProtocol";
import { planInstructions } from "../src/lib/crmAssistantPlan";

// codex.ts and crmAssistant.ts reach server-only; their pure helpers load with it stubbed.
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

/* ── Streaming: the person never sees a trailer line, even half-written ──── */

test("while streaming, nothing of LEARN / ACTIONS / CHOICES ever shows — at any character", () => {
  const full = 'Gavin needs a delivery check.\n\nI\'d ask Donovan first.\nLEARN: {"memory":[{"add":"x"}]}\nACTIONS: [{"type":"note"}]\nCHOICES: ["Call","WhatsApp"]';
  for (let i = 1; i <= full.length; i++) {
    const shown = visibleAnswer(full.slice(0, i));
    assert.doesNotMatch(shown, /LEARN|ACTIONS|CHOICES|"memory"|"type"|\bLEA$|\bACT$|\bCHO$/, `at ${i}: ${JSON.stringify(shown)}`);
  }
  assert.equal(visibleAnswer(full), "Gavin needs a delivery check.\n\nI'd ask Donovan first.");
  assert.equal(visibleAnswer("Leads gone quiet: 3\nActually fine."), "Leads gone quiet: 3\nActually fine.", "ordinary lines are shown");
});

test("the route accepts only same-origin requests", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  assert.equal(isSameOrigin(h({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(isSameOrigin(h({ "sec-fetch-site": "cross-site", origin: "https://crm.denagocpt.co.za", host: "crm.denagocpt.co.za" })), false, "the browser's word wins");
  assert.equal(isSameOrigin(h({ "sec-fetch-site": "same-site" })), false, "a sibling subdomain is not us");
  assert.equal(isSameOrigin(h({ origin: "https://crm.denagocpt.co.za", host: "crm.denagocpt.co.za" })), true);
  assert.equal(isSameOrigin(h({ origin: "https://evil.example", host: "crm.denagocpt.co.za" })), false);
  assert.equal(isSameOrigin(h({ host: "crm.denagocpt.co.za" })), false, "no origin at all is refused");
});

test("the streaming route: same-origin, signed in, permitted — then the shared ask path", () => {
  const route = code("src/app/api/assistant/ask/route.ts");
  const asker = route.slice(route.indexOf("async function signedInAsker"), route.indexOf("function ndjson"));
  assert.ok(asker.indexOf("requireApiUser()") >= 0 && asker.indexOf("requireApiUser()") < asker.indexOf("hasAnyPermission(user, ...ASSISTANT_PERMISSIONS)"));
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function GET"));
  const order = ["isSameOrigin(req.headers)", "signedInAsker()", "const tenantId = inheritedTenantId();", "claimRun(tenantId, user.id, key)", "askAsPerson("];
  for (let i = 1; i < order.length; i++) assert.ok(post.indexOf(order[i - 1]) >= 0 && post.indexOf(order[i - 1]) < post.indexOf(order[i]), `${order[i - 1]} before ${order[i]}`);
  // A key that already ran is only READ — never asked again — in this workspace.
  assert.match(post, /if \(key && claimed && !claimed\.created\) return ndjson\(\(send\) => follow\(tenantId, user\.id, key, send\)\);/);
  assert.match(post, /runRecorder\(claimed\.id, tenantId, user\.id\)/);
  // The reconnect path checks the same things and can only read.
  const get = route.slice(route.indexOf("export async function GET"));
  assert.ok(get.indexOf("isSameOrigin(req.headers)") < get.indexOf("signedInAsker()"));
  assert.doesNotMatch(get, /askAsPerson|claimRun/);
  assert.match(get, /const tenantId = inheritedTenantId\(\);\s*return ndjson\(\(send\) => follow\(tenantId, userId, key, send\)\);/);
  assert.match(route, /export const maxDuration = 300;/);
  assert.match(route, /"Cache-Control": "no-store"/);
  // The route is the only way in: no second ask path to fall back to.
  assert.doesNotMatch(code("src/app/actions/assistant.ts"), /askAsPerson|askCrm\(/);
  const shared = code("src/lib/assistantAsk.ts");
  const steps = ['isModuleEnabled("automation")', "assistantAskAllowed(user.id)", "assistantImageAllowed(user.id)", 'file.type !== "image/jpeg"', "cleanJpeg(", "return askCrm("];
  for (let i = 1; i < steps.length; i++) assert.ok(shared.indexOf(steps[i - 1]) < shared.indexOf(steps[i]), `${steps[i - 1]} before ${steps[i]}`);
});

/* ── One click, one ask: a dropped stream is never asked again ───────────── */

// A fetch stand-in: records every call, answers with a stream that sends
// `events` and then either ends or breaks.
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return respond();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const streamOf = (chunks: string[], end: "close" | "break") =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        if (end === "close") c.close();
        else c.error(new TypeError("network error"));
      },
    }),
    { status: 200 },
  );

test("a connection lost at any point is never re-asked: it reconnects to the same run and reads it", async () => {
  const { askStreaming, STREAM_DROPPED, RECONNECT_DELAYS_MS } = await import("../src/components/askStream");
  const noPause = { pause: async () => {}, key: "run_test_key_1" };
  const done = '{"t":"done","r":{"ok":true,"answer":"Gavin needs a delivery check.","rows":[]}}\n';
  for (const make of [
    () => streamOf([], "break"), // dropped during research: nothing sent yet
    () => streamOf([], "close"), // cut off cleanly with no "done"
    () => streamOf(['{"t":"text","v":"Gavin"}\n'], "break"), // dropped mid-answer
    () => { throw new TypeError("Failed to fetch"); }, // the request may still have arrived
    () => new Response("Bad gateway", { status: 502 }), // a gateway cut off a request that may have run
  ]) {
    // The first call (the POST) fails; the reconnect reads the finished run.
    let n = 0;
    const net = fakeFetch(() => (n++ === 0 ? make() : streamOf([done], "close")));
    try {
      const form = new FormData();
      const result = await askStreaming(form, () => {}, () => {}, noPause);
      assert.deepEqual(result, { ok: true, answer: "Gavin needs a delivery check.", rows: [] });
      assert.deepEqual(net.calls, ["/api/assistant/ask", "/api/assistant/ask?run=run_test_key_1"], "POSTed once; the retry only reads the run");
      assert.equal(form.get("runKey"), "run_test_key_1", "the run is named before it is sent");
    } finally {
      net.restore();
    }
  }
  // Every reconnect failing too: told plainly, and still asked only once.
  const net = fakeFetch(() => streamOf([], "break"));
  try {
    assert.deepEqual(await askStreaming(new FormData(), () => {}, () => {}, noPause), { ok: false, error: STREAM_DROPPED });
    assert.equal(net.calls.filter((c) => c === "/api/assistant/ask").length, 1, "one POST");
    assert.equal(net.calls.length, 1 + RECONNECT_DELAYS_MS.length);
  } finally {
    net.restore();
  }
  // The chat has no second way to ask.
  const chat = code("src/components/AssistantChat.tsx");
  assert.match(chat, /const result = await askStreaming\(\s*form,\s*\(text\) => setLive\(\{ question: shown, text \}\),\s*\(status\) => setLive\(/);
  assert.doesNotMatch(chat, /askCrmAction|askCrm\(/);
});

test("a full stream returns its answer; a refusal says try again", async () => {
  const { askStreaming } = await import("../src/components/askStream");
  const seen: string[] = [];
  let net = fakeFetch(() => streamOf(['{"t":"text","v":"Hi"}\n{"t":"te', 'xt","v":"Hi there"}\n{"t":"done","r":{"ok":true,"answer":"Hi there","rows":[]}}\n'], "close"));
  try {
    const result = await askStreaming(new FormData(), (t) => seen.push(t));
    assert.deepEqual(result, { ok: true, answer: "Hi there", rows: [] });
    assert.deepEqual(seen, ["Hi", "Hi there"], "a line split across chunks is joined");
    assert.deepEqual(net.calls, ["/api/assistant/ask"]);
  } finally {
    net.restore();
  }
  net = fakeFetch(() => new Response("{}", { status: 403 }));
  try {
    assert.deepEqual(await askStreaming(new FormData(), () => {}), { ok: false, error: "Something went wrong — try again." });
  } finally {
    net.restore();
  }
  const client = code("src/components/askStream.ts");
  assert.match(client, /fetch\("\/api\/assistant\/ask", \{ method: "POST", body: form, credentials: "same-origin" \}\)/);
});

/* ── Prompt cache: a stable key per person, and a frozen prefix ─────────── */

test("each person's calls share a cache key — hashed, so no id is sent — and a one-off call gets none", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cacheIdentity } = require("../src/lib/codex") as typeof import("../src/lib/codex");
  const a = cacheIdentity("dax:tenant_denago_cpt:cmr871smu0000uw9cgaxeflmk");
  assert.deepEqual(cacheIdentity("dax:tenant_denago_cpt:cmr871smu0000uw9cgaxeflmk"), a, "stable across calls");
  assert.notEqual(cacheIdentity("dax:tenant_denago_cpt:someone-else").cacheKey, a.cacheKey, "per person");
  assert.match(a.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!a.cacheKey.includes("tenant") && !a.sessionId.includes("cmr8"), "no tenant or user id leaves");
  const codex = code("src/lib/codex.ts");
  assert.match(codex, /\.\.\.\(identity \? \{ prompt_cache_key: identity\.cacheKey \} : \{\}\)/);
  assert.match(codex, /const sessionId = identity\?\.sessionId \?\? crypto\.randomUUID\(\);/);
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const cacheKey = `dax:\$\{ownedWriteTenantId\(\)\}:\$\{user\.id\}`;/);
  assert.equal((lib.match(/cacheKey(,| \})/g) ?? []).length >= 2, true, "the plan call (every try) and the answer use it");
});

test("what varies comes LAST in the research instructions, so the cached prefix holds", () => {
  const a = planInstructions({ today: "2026-10-05", userName: "Sean", stages: ["New"], staff: ["Donovan"], activityTypes: ["call"] });
  const b = planInstructions({ today: "2026-10-06", userName: "Donovan", stages: ["New", "Won"], staff: ["Sean"], activityTypes: ["todo"], learned: "x" });
  let same = 0;
  while (same < a.length && a[same] === b[same]) same++;
  assert.ok(same > 4000, `the first ${same} characters are identical whoever asks, whatever the day`);
  assert.ok(a.indexOf("Today is") > a.indexOf("YOU NEVER WRITE THE ANSWER"));
  // …and sorted lists, so the database's order can't reshuffle them.
  assert.match(code("src/lib/crmAssistant.ts"), /activityTypes: types\.map\(\(t\) => t\.type\)\.sort\(/);
});

test("the answer step: the per-question part last; today's date in the prompt, not the cached instructions", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const answer = lib.slice(lib.indexOf("const answerReply = await withRetry("));
  assert.match(answer, /images\.length \? IMAGE_RULE : "",\s*methodInstructions\(observations\),\s*\]/);
  assert.match(answer, /prompt: \[\s*`Now: \$\{nowInSouthAfrica\(\)\}\.`,/);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { nowInSouthAfrica } = require("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");
  assert.equal(nowInSouthAfrica(new Date("2026-10-05T22:30:00Z")), "Tuesday 6 October 2026, 00:30 (South African time)");
});

test("usage is read from the stream, so cache hits can be measured", () => {
  const stream = [
    'data: {"type":"response.output_text.delta","delta":"Hi"}',
    'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":3780,"input_tokens_details":{"cached_tokens":2944}}}}',
  ].join("\n");
  assert.deepEqual(parseCodexStream(stream).usage, { inputTokens: 3780, cachedTokens: 2944 });
});
