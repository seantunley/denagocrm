import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { OPENING_FACTS, openingLine, type BriefItem } from "../src/lib/daxBriefRules";
import { openingLineOn } from "../src/lib/proactiveRules";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const item = (key: string, title: string, href: string, detail?: string): BriefItem => ({ key, tone: "info", emoji: "", title, href, ...(detail ? { detail } : {}) });

test("DAX speaks first: the brief's top two items, in its order, each linked — nothing to say, nothing said", () => {
  const brief = {
    items: [
      item("waiting", "1 customer waiting for a reply", "/leads/l1", "Anna — waiting 2 days"),
      item("quote_expiring", "2 quotes expiring", "/leads/attention", "Bob — expires tomorrow"),
      item("stale", "3 stale deals worth recovering", "/leads/attention", "Cara — 40 days in Quoted"),
    ],
  };
  assert.equal(OPENING_FACTS, 2);
  assert.deepEqual(openingLine(brief), {
    facts: [
      { text: "1 customer waiting for a reply (Anna — waiting 2 days)", href: "/leads/l1" },
      { text: "2 quotes expiring (Bob — expires tomorrow)", href: "/leads/attention" },
    ],
  });
  assert.deepEqual(openingLine({ items: [item("agenda", "Today: 2 meetings", "/calendar")] }), { facts: [{ text: "Today: 2 meetings", href: "/calendar" }] });
  assert.equal(openingLine({ items: [] }), null, "no 'nothing new' filler");
});

test("the switch is each person's own, on unless switched off, read in this workspace", () => {
  assert.equal(openingLineOn(null), true);
  assert.equal(openingLineOn("on"), true);
  assert.equal(openingLineOn("off"), false);
  assert.match(code("src/lib/daxBrief.ts"), /openingLineOn\(await getWorkspaceSetting\(ownedWriteTenantId\(\), openingLineKey\(user\.id\)\)\)/);
  assert.match(code("src/app/actions/assistantSettings.ts"), /await putWorkspaceSetting\(tenantId, key, on === true \? "on" : "off"\);/);
});

test("shown only into an empty conversation, on the Ask page and the panel — never WhatsApp, never an AI call", () => {
  assert.match(code("src/app/actions/assistant.ts"), /connected && history\.length === 0 \? await openingLineFor\(user\)\.catch\(\(\) => null\) : null/);
  assert.match(code("src/app/(app)/assistant/page.tsx"), /picked !== "updates" && history\.length === 0 \? await openingLineFor\(user\)\.catch\(\(\) => null\) : null/);
  const chat = code("src/components/AssistantChat.tsx");
  assert.match(chat, /thread\.length === 0 && !pending && \(opening \?/);
  assert.match(chat, /turns\.length === 0 && !pending && opening && <Opening/);
  const loader = code("src/lib/daxBrief.ts");
  assert.doesNotMatch(loader.slice(loader.indexOf("export async function openingLineFor")), /askCrm|codex|openai|logError|console\./i);
  assert.doesNotMatch(code("src/lib/assistantWhatsApp.ts"), /openingLineFor/);
});
