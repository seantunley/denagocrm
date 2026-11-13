import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { answerForWhatsApp, parseAnswer, parseInline } from "../src/lib/answerMarkup";
import { forWhatsApp, planWhatsAppReply } from "../src/lib/assistantWhatsAppRules";
import { speakableText } from "../src/lib/spokenText";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Sean, 2026-11-13: "rendering short lists, bold and small tables would make 'my five stuck deals' readable at a glance". */
const stuck = [
  "Your **five** most-stuck deals:",
  "",
  "| Deal | Stage | Days |",
  "|---|---|---|",
  "| [Anna Jacobs](/leads/cm1) | Quoted | **21** |",
  "| Ben Smit | Test ride | 14 |",
  "",
  "- Call Anna first [[1]]",
  "- Then Ben",
  "",
  "1. Chase the quote",
  "2. Book the ride",
].join("\n");

test("bold, lists, a small table, links and citations come out as their own pieces", () => {
  const blocks = parseAnswer(stuck);
  assert.deepEqual(blocks.map((b) => b.type), ["p", "table", "ul", "ol"]);
  const table = blocks[1] as Extract<(typeof blocks)[number], { type: "table" }>;
  assert.deepEqual(table.head.map((cell) => cell.map((p) => (p.t === "text" ? p.v : p.t))), [["Deal"], ["Stage"], ["Days"]]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0][0], [{ t: "link", label: "Anna Jacobs", href: "/leads/cm1", external: false }]);
  assert.deepEqual(table.rows[0][2], [{ t: "bold", v: "21" }]);
  assert.deepEqual((blocks[2] as { items: unknown[] }).items[0], [{ t: "text", v: "Call Anna first " }, { t: "cite", n: 1 }]);
  assert.equal((blocks[3] as { items: unknown[] }).items.length, 2);
  // Plain answers read exactly as before: paragraphs, line breaks kept.
  assert.deepEqual(parseAnswer("Line one\nLine two\n\nNext"), [
    { type: "p", lines: [[{ t: "text", v: "Line one" }], [{ t: "text", v: "Line two" }]] },
    { type: "p", lines: [[{ t: "text", v: "Next" }]] },
  ]);
});

test("nothing from the text becomes markup it shouldn't — no script links, no HTML", () => {
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [{ t: "text", v: "click" }, { t: "text", v: ")" }]);
  assert.deepEqual(parseInline("[x](//evil.example)"), [{ t: "text", v: "x" }]);
  assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [{ t: "text", v: "<img src=x onerror=alert(1)>" }], "stays text");
  assert.deepEqual(parseInline("[Tannery](https://tannerycars.co.za/x)"), [{ t: "link", label: "Tannery", href: "https://tannerycars.co.za/x", external: true }]);
  const renderer = src("src/components/AnswerMarkup.tsx");
  assert.doesNotMatch(renderer, /dangerouslySetInnerHTML/);
  assert.match(renderer, /target="_blank" rel="noopener noreferrer"/);
});

test("WhatsApp gets its own marks: *bold*, a table as lines, no CRM links", () => {
  const out = forWhatsApp(stuck);
  assert.match(out, /Your \*five\* most-stuck deals:/);
  assert.match(out, /\*Deal · Stage · Days\*/);
  assert.match(out, /^Anna Jacobs · Quoted · \*21\*$/m);
  assert.doesNotMatch(out, /\|---|\/leads\/|\*\*/);
  assert.equal(answerForWhatsApp("## Today"), "*Today*");
  assert.doesNotMatch(planWhatsAppReply(stuck).texts.join("\n"), /\*\*|\|/);
});

test("a voice note says a table row as a short list, never the dividers", () => {
  const said = speakableText(stuck);
  assert.doesNotMatch(said, /\||\*/);
  assert.match(said, /Deal, Stage, Days/);
});

test("DAX is told the formatting it may use", () => {
  const rules = src("src/lib/crmAssistantPlan.ts");
  assert.match(rules, /\*\*bold\*\* for the one figure, name or decision/);
  assert.match(rules, /a small table \(\| Deal \| Stage \| Value \|/);
  assert.doesNotMatch(rules, /Plain text only \(short paragraphs or simple '-' lists\), no markdown tables/);
  const chat = src("src/components/AssistantChat.tsx");
  assert.match(chat, /<AnswerMarkup text=\{turn\.cited\} evidence=\{turn\.evidence\} \/>/);
  assert.equal((chat.match(/<AnswerMarkup text=\{live\.text\} \/>/g) ?? []).length, 2, "formatted while it streams too, in both views");
  assert.doesNotMatch(chat, /whitespace-pre-line text-sm leading-relaxed">\{(turn\.answer|live\.text)\}/);
});
