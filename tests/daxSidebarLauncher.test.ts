import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { publishDax, registerDax, toggleDax } from "../src/lib/daxLauncher";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Sean, 2026-11-13: the floating DAX button goes; the sidebar's Ask the CRM button opens the same chat panel. */
test("the sidebar button toggles the panel when there is one, and is a plain link when there isn't", () => {
  assert.equal(toggleDax(), false, "no panel mounted (DAX off, a phone): the link goes to /assistant");
  let toggled = 0;
  const unregister = registerDax(() => { toggled += 1; });
  assert.equal(toggleDax(), true);
  assert.equal(toggled, 1);
  publishDax({ open: true, unread: false });
  unregister();
  assert.equal(toggleDax(), false, "unmounted panel: back to a link");
});

test("the floating button is gone; the panel and the sidebar button share open and unread", () => {
  const bubble = src("src/components/AssistantBubble.tsx");
  assert.doesNotMatch(bubble, /fixed bottom-20 right-4/, "no floating round button");
  assert.doesNotMatch(bubble, /<button\s+type="button"\s+onClick=\{toggle\}/);
  assert.match(bubble, /registerDax\(\(\) => void toggleRef\.current\(\)\)/);
  assert.match(bubble, /publishDax\(\{ open, unread \}\)/);
  assert.match(bubble, /event\.key === "Escape"\) setOpen\(false\)/, "Escape closes it — its button is no longer beside it");
  assert.match(bubble, /window\.addEventListener\("dax:ask", onAsk\)/, "the home brief's 'Ask DAX for a plan' still opens it");

  const nav = src("src/components/Nav.tsx");
  assert.match(nav, /function FootButton/);
  // A new-tab click, the Ask page itself, and no panel all let the link go to /assistant.
  assert.match(nav, /if \(active \|\| event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) return;\s*if \(toggleDax\(\)\) event\.preventDefault\(\);/);
  assert.match(nav, /const dot = unread && !open;/, "the red dot moved to the sidebar button");
  // Review of #1090: it opens something, so it is a BUTTON to the keyboard — Space works as well as Enter.
  assert.match(nav, /const asButton = active \? \{ "aria-current": "page" as const \} : \{ role: "button", "aria-expanded": open, onKeyDown \};/);
  assert.match(nav, /if \(event\.key !== " "\) return;\s*event\.preventDefault\(\);[\s\S]*if \(!toggleDax\(\)\) event\.currentTarget\.click\(\);/);
  assert.equal((nav.match(/\{\.\.\.asButton\}/g) ?? []).length, 2, "open sidebar and rail");
  assert.equal((nav.match(/<FootButton /g) ?? []).length, 2, "open sidebar and collapsed rail");

  // Still not on a phone: the panel is desktop-only, and the foot link is taken out after the phone filter.
  assert.match(src("src/app/(app)/layout.tsx"), /<div className="max-md:hidden"><AssistantBubble unseen=\{assistantUnseen\} \/><\/div>/);
  assert.match(src("src/lib/help/articles/assistant-and-more.ts"), /Ask the CRM button at the bottom of the sidebar/);
});
