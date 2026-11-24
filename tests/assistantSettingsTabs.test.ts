import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tabAfterKey, tabFromHash } from "../src/lib/sectionTabs";

const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const IDS = ["learned", "personality", "reach", "results", "advanced"];

test("the address decides the tab, and anything unknown opens the first", () => {
  assert.equal(tabFromHash("", IDS, "learned"), "learned");
  assert.equal(tabFromHash("#reach", IDS, "learned"), "reach");
  assert.equal(tabFromHash("#learned", IDS, "learned"), "learned", "links written before the tabs still land");
  assert.equal(tabFromHash("#nonsense", IDS, "learned"), "learned");
  assert.equal(tabFromHash("#%20advanced", IDS, "learned"), "advanced");
  // A malformed fragment is a bad link, not a crash (review of #1223).
  for (const bad of ["#%E0%A4%A", "#%", "#%zz", "#advanced%"]) assert.equal(tabFromHash(bad, IDS, "learned"), "learned", bad);
});

test("arrow keys move between tabs and wrap; other keys do nothing", () => {
  assert.equal(tabAfterKey("ArrowRight", IDS, "learned"), "personality");
  assert.equal(tabAfterKey("ArrowRight", IDS, "advanced"), "learned");
  assert.equal(tabAfterKey("ArrowLeft", IDS, "learned"), "advanced");
  assert.equal(tabAfterKey("Home", IDS, "results"), "learned");
  assert.equal(tabAfterKey("End", IDS, "results"), "advanced");
  assert.equal(tabAfterKey("Enter", IDS, "results"), null);
  assert.equal(tabAfterKey("ArrowRight", IDS, "missing"), null);
});

test("every panel stays in the page, so a form in a hidden tab still saves", () => {
  const tabs = code("src/components/SectionTabs.tsx");
  assert.match(tabs, /hidden=\{tab\.id !== active\}/);
  assert.match(tabs, /\{panels\[tab\.id\]\}/);
  assert.doesNotMatch(tabs, /tab\.id === active &&|active === tab\.id \?/, "panels are hidden, never unmounted");
  // Each tab is its own history entry, so Back and Forward step through them; nothing scrolls (review of #1223).
  assert.match(tabs, /if \(id !== active\) window\.history\.pushState\(null, "", `#\$\{id\}`\);/);
  assert.doesNotMatch(tabs, /replaceState/);
  assert.match(tabs, /window\.addEventListener\("popstate", onChange\);/);
});

test("the assistant settings page is five tabs, and every section it had is in one of them", () => {
  const page = code("src/app/(app)/settings/assistant/page.tsx");
  for (const id of IDS) {
    assert.match(page, new RegExp(`\\{ id: "${id}", label: `), id);
    assert.match(page, new RegExp(`\\n\\s+${id}: [<(]`), `${id} has a panel`);
  }
  const at = (mark: string) => {
    const index = page.indexOf(mark);
    assert.ok(index > 0, mark);
    return index;
  };
  const panel = (id: string) => at(`\n          ${id}: `);
  const inside = (mark: string, id: string, next: string | null) => {
    assert.ok(at(mark) > panel(id), `${mark} is in ${id}`);
    if (next) assert.ok(at(mark) < panel(next), `${mark} is before ${next}`);
  };
  inside("action={saveAssistantProfile} resetOnSuccess={false} className=\"card space-y-5 p-5\"", "personality", "reach");
  inside("action={saveAssistantProactive}", "reach", "results");
  inside("action={saveAssistantWhatsAppCard}", "reach", "results");
  inside("phones.length > 0 && (", "reach", "results");
  inside("How {profile.name} is doing", "results", "advanced");
  inside("suggestions worked out", "results", "advanced");
  inside("Its soul", "advanced", null);
  inside("action={saveOutcomeLearning}", "advanced", null);
  assert.doesNotMatch(page, /max-w-2xl/, "one width for every section, set by the tab panel");
});

test("a settled entry is one line until opened; one waiting on the owner is shown in full", () => {
  const review = code("src/components/AssistantLearnedReview.tsx");
  assert.match(review, /return note\.status !== "approved" \|\| note\.expired \|\|/);
  // The tab's badge counts with the same rule, so an expired or flagged approved entry is counted too (review of #1223).
  assert.match(review, /export function needsAttention\(note: LearnedNote\): boolean/);
  assert.match(code("src/app/(app)/settings/assistant/page.tsx"), /count: learned\.filter\(needsAttention\)\.length/);
  assert.match(review, /needsAttention\(note\) \? \(\s*<li key=\{note\.id\} className="space-y-2 py-3">\s*<NoteDetail note=\{note\} \/>/);
  assert.match(review, /<details className="group\/note">[\s\S]*<NoteDetail note=\{note\} settled \/>/);
  assert.match(review, /Number\(needsAttention\(b\)\) - Number\(needsAttention\(a\)\)/, "what's waiting comes first");
  // Every action the owner had is still there, once.
  for (const action of ["approveAssistantNote.bind(null, note.id)", "updateAssistantNote.bind(null, note.id)", "deleteAssistantNote.bind(null, note.id)", 'resolveAssistantConflict.bind(null, note.id, "new")', 'resolveAssistantConflict.bind(null, note.id, "existing")']) {
    assert.equal(review.split(action).length - 1, 1, action);
  }
});
