import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { HELP_ARTICLES } from "../src/lib/help/content";
import { WHATS_NEW, longDate, parseSeen, unseenCount, whatsNewFor, withSeen, type WhatsNewEntry } from "../src/lib/help/whatsNew";
import {
  MAX_BODY, MAX_GUIDES, MAX_TITLE, guideBlocks, parseGuides, readGuideInput, removeGuide, saveGuide, type CustomGuide,
} from "../src/lib/help/customGuides";

const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SLUGS = new Set(HELP_ARTICLES.map((article) => article.slug));

/* ── What's new ───────────────────────────────────────────────────────── */

test("every entry has a unique id, a real date, and is listed newest first", () => {
  assert.equal(new Set(WHATS_NEW.map((entry) => entry.id)).size, WHATS_NEW.length);
  for (const entry of WHATS_NEW) {
    assert.match(entry.id, /^[a-z0-9-]{3,80}$/);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(entry.date)), entry.id);
    assert.ok(entry.title.trim() && entry.text.trim(), entry.id);
  }
  const dates = WHATS_NEW.map((entry) => entry.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), "add new entries at the top");
});

test("every entry's link goes to a page or a guide that exists", () => {
  for (const entry of WHATS_NEW) {
    if (!entry.href) continue;
    if (entry.href.startsWith("/help/")) assert.ok(SLUGS.has(entry.href.slice(6)), `${entry.id}: no guide ${entry.href}`);
    else assert.ok(existsSync(`src/app/(app)${entry.href}/page.tsx`), `${entry.id}: no page ${entry.href}`);
  }
});

const E = (id: string, date: string, extra: Partial<WhatsNewEntry> = {}): WhatsNewEntry => ({ id, date, title: id, text: id, ...extra });
const LIST = [E("all", "2026-11-01"), E("owner", "2026-11-03", { ownerOnly: true }), E("auto", "2026-11-02", { module: "automotive" })];

test("an entry is shown only to who it is for, newest first", () => {
  const ids = (owner: boolean, modules: string[] | null) => whatsNewFor(LIST, { owner, modules: modules && new Set(modules) }).map((entry) => entry.id);
  assert.deepEqual(ids(false, []), ["all"]);
  assert.deepEqual(ids(false, ["automotive"]), ["auto", "all"]);
  assert.deepEqual(ids(true, ["automotive"]), ["owner", "auto", "all"]);
  assert.deepEqual(ids(true, null), ["owner", "all"], "modules unknown: nothing tied to a module");
});

test("the dot counts what has not been seen, and seeing is remembered once", () => {
  assert.equal(unseenCount(LIST, new Set()), 3);
  const once = withSeen(null, ["all", "auto"]);
  assert.equal(unseenCount(LIST, parseSeen(once)), 1);
  assert.equal(withSeen(once, ["all"]), null, "nothing new to write");
  assert.equal(unseenCount(LIST, parseSeen(withSeen(once, ["owner"]))), 0);
  for (const bad of [null, "", "nope", "{}", '[1,"<b>"]']) assert.equal(parseSeen(bad).size, 0, String(bad));
});

test("a date reads the same in every time zone", () => {
  assert.equal(longDate("2026-11-23"), "23 November 2026");
  assert.equal(longDate("2026-01-01"), "1 January 2026");
  assert.equal(longDate("garbage"), "garbage");
});

test("opening What's new clears the dot, and the help icon carries it", () => {
  const page = code("src/app/(app)/help/whats-new/page.tsx");
  assert.match(page, /<MarkWhatsNewSeen ids=\{entries\.map\(\(entry\) => entry\.id\)\} \/>/);
  assert.match(page, /whatsNewFor\(WHATS_NEW, \{ owner, modules \}\)/);
  const menu = code("src/components/SidebarHelpSettings.tsx");
  assert.match(menu, /<WhatsNewDot className=/);
  assert.match(menu, /<Link href="\/help\/whats-new"/);
  assert.match(code("src/components/help/WhatsNewDot.tsx"), /if \(unseen === 0\) return null;/);
});

/* ── The workspace's own guides ───────────────────────────────────────── */

const GOOD = { title: "How we handle trade-ins", summary: "Before, during and after.", area: "sales", body: "# Before\n\n1. Check history\n2. Photograph it\n\n> Never agree a value by phone." };
const input = () => {
  const read = readGuideInput(GOOD);
  assert.ok(read.ok);
  return read.input;
};
const meta = (id: string, existing = false) => ({ id, existing, at: "2026-11-23T10:00:00.000Z", by: "Owner" });

test("what the owner types is checked, with a message that says what to change", () => {
  assert.equal(readGuideInput(GOOD).ok, true);
  const bad = (fields: Partial<Record<keyof typeof GOOD, unknown>>) => {
    const read = readGuideInput({ ...GOOD, ...fields });
    assert.equal(read.ok, false);
    return read.ok ? "" : read.error;
  };
  assert.match(bad({ title: "  " }), /title/);
  assert.match(bad({ title: "x".repeat(MAX_TITLE + 1) }), /title/);
  assert.match(bad({ area: "made-up" }), /area/);
  assert.match(bad({ body: "" }), /Write the guide/);
  assert.match(bad({ body: "x".repeat(MAX_BODY + 1) }), /Write the guide/);
  assert.match(bad({ summary: "x".repeat(500) }), /summary/);
  assert.equal(readGuideInput({ ...GOOD, summary: "" }).ok, true, "the summary is optional");
});

test("adding, editing and deleting keep one copy of each guide, newest edit first", () => {
  const first = saveGuide([], input(), meta("aaaaaaaa"));
  assert.ok(first.ok);
  const second = saveGuide(first.guides, { ...input(), title: "Delivery checklist" }, meta("bbbbbbbb"));
  assert.ok(second.ok);
  assert.deepEqual(second.guides.map((guide) => guide.title), ["Delivery checklist", "How we handle trade-ins"]);
  const edited = saveGuide(second.guides, { ...input(), title: "Trade-ins" }, meta("aaaaaaaa", true));
  assert.ok(edited.ok);
  assert.deepEqual(edited.guides.map((guide) => guide.title), ["Trade-ins", "Delivery checklist"]);
  assert.deepEqual(removeGuide(edited.guides, "aaaaaaaa").map((guide) => guide.id), ["bbbbbbbb"]);
});

test("an edit to a deleted guide, a clashing id, and a full list are refused", () => {
  const one = saveGuide([], input(), meta("aaaaaaaa"));
  assert.ok(one.ok);
  assert.equal(saveGuide(one.guides, input(), meta("zzzzzzzz", true)).ok, false);
  assert.equal(saveGuide(one.guides, input(), meta("aaaaaaaa")).ok, false);
  assert.equal(saveGuide(one.guides, input(), meta("../etc")).ok, false);
  const full: CustomGuide[] = Array.from({ length: MAX_GUIDES }, (_, i) => ({ ...input(), id: `guide${String(i).padStart(4, "0")}`, updatedAt: "", updatedBy: "" }));
  const refused = saveGuide(full, input(), meta("cccccccc"));
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && /up to 40/.test(refused.error));
  assert.equal(saveGuide(full, input(), meta("guide0003", true)).ok, true, "a full list can still be edited");
});

test("a damaged setting reads as no guides, and a damaged entry is dropped alone", () => {
  for (const bad of [null, "", "not json", "{}", "42"]) assert.deepEqual(parseGuides(bad), []);
  const stored = JSON.stringify([
    { id: "aaaaaaaa", ...GOOD, updatedAt: "2026-11-23T10:00:00.000Z", updatedBy: "Owner" },
    { id: "bad id!", ...GOOD },
    { id: "bbbbbbbb", ...GOOD, area: "nowhere" },
    { id: "aaaaaaaa", ...GOOD, title: "A duplicate id" },
    "a string",
  ]);
  assert.deepEqual(parseGuides(stored).map((guide) => guide.title), ["How we handle trade-ins"]);
});

test("plain text becomes headings, steps, bullets, tips and paragraphs", () => {
  assert.deepEqual(guideBlocks("# Before\n\nCheck the\nhistory first.\n\n1. One\n2) Two\n\n- a\n* b\n\n> Never by phone.\nAfter."), [
    { type: "h", text: "Before" },
    { type: "p", text: "Check the history first." },
    { type: "steps", items: ["One", "Two"] },
    { type: "list", items: ["a", "b"] },
    { type: "callout", tone: "tip", text: "Never by phone." },
    { type: "p", text: "After." },
  ]);
  // A list straight after a paragraph, and bullets straight after steps, each start their own block.
  assert.deepEqual(guideBlocks("Intro\n- a\n1. b").map((block) => block.type), ["p", "list", "steps"]);
  assert.deepEqual(guideBlocks("   \n\n"), []);
});

test("markup in a guide stays text — it is never handed to the page as HTML", () => {
  const blocks = guideBlocks('<script>alert(1)</script>\n\n<img src=x onerror="go()">');
  assert.deepEqual(blocks.map((block) => block.type), ["p", "p"]);
  assert.doesNotMatch(code("src/components/help/ArticleBody.tsx"), /dangerouslySetInnerHTML/);
  assert.doesNotMatch(code("src/app/(app)/help/ours/[id]/page.tsx"), /dangerouslySetInnerHTML/);
});

test("only the owner writes: the actions check before reading the form, name the workspace, and audit", () => {
  const actions = code("src/app/actions/helpGuides.ts");
  assert.equal(actions.match(/const user = await requireTenantOwner\(\);/g)?.length, 2);
  assert.ok(actions.indexOf("requireTenantOwner()") < actions.indexOf("formData.get("));
  assert.equal(actions.match(/await logAudit\(/g)?.length, 2);
  const store = code("src/lib/help/customGuidesStore.ts");
  assert.equal(store.match(/await settingsTenantId\(\), CUSTOM_GUIDES_KEY/g)?.length, 2, "read and write both name the acting workspace");
  for (const page of ["new/page.tsx", "[id]/edit/page.tsx"]) assert.match(code(`src/app/(app)/help/ours/${page}`), /await requireTenantOwner\(\);/);
});

test("the new help pages don't shadow a built-in guide", () => {
  for (const taken of ["ours", "whats-new"]) assert.ok(!SLUGS.has(taken), taken);
});

test("own guides lead the side menu, and the home shows both doors beside the reader's path", () => {
  const layout = code("src/app/(app)/help/layout.tsx");
  assert.match(layout, /slug: `ours\/\$\{g\.id\}`/);
  assert.match(layout, /loadCustomGuides\(\)\.catch\(\(\) => \[\]\)/, "help still opens if the setting can't be read");
  const home = code("src/app/(app)/help/page.tsx");
  assert.match(home, /beside=\{<HelpDoors latest=/);
  assert.match(home, /slug: `ours\/\$\{guide\.id\}`/, "the big search finds the workspace's own guides");
});
