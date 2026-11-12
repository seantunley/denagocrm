import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Sidebar brief PR 3 — quiet motion. Only transform and opacity; nothing moves under reduced motion. */
const nav = readFileSync("src/components/Nav.tsx", "utf8").replace(/\r\n/g, "\n");

test("reduced motion: framer's transform and layout animations off for the whole menu; CSS transitions off too", () => {
  assert.match(nav, /<MotionConfig reducedMotion="user">/);
  for (const transition of nav.match(/transition-(?:opacity|transform)[^"]*/g) ?? []) {
    assert.match(transition, /motion-reduce:transition-none/, transition);
  }
  // Nothing animates layout properties by hand: width, height, top, left, margin.
  assert.doesNotMatch(nav, /animate=\{\{[^}]*(width|height|top|left|margin)/);
});

test("the raised pill glides to the new link (~180ms ease-out), scoped per sidebar", () => {
  assert.match(nav, /layoutId="nav-pill"/);
  assert.match(nav, /transition=\{\{ duration: 0\.18, ease: EASE_OUT \}\}/);
  assert.match(nav, /<LayoutGroup id=\{phone \? "nav-drawer" : "nav-desktop"\}>/, "the drawer's pill never animates to the desktop's");
});

test("a faint shadow under the search block once the menu has scrolled", () => {
  assert.match(nav, /onScroll=\{\(event\) => setScrolled\(event\.currentTarget\.scrollTop > 0\)\}/);
  assert.match(nav, /sticky top-0[^"]*transition-opacity[^"]*", scrolled \? "opacity-100" : "opacity-0"/);
});

test("a count pulses once when it rises — never on first render, never looping", () => {
  assert.match(nav, /if \(seen\.n !== n\) setSeen\(\{ n, rises: n > seen\.n \? seen\.rises \+ 1 : seen\.rises \}\);/);
  assert.match(nav, /key=\{seen\.rises\}/);
  assert.match(nav, /animate=\{seen\.rises > 0 \? \{ scale: \[1, 1\.15, 1\] \} : undefined\}/);
  assert.doesNotMatch(nav, /repeat:|Infinity/);
});

test("a group's links ease in (150ms, a few pixels, a fade); hovering a link brightens its guide line", () => {
  assert.match(nav, /initial=\{\{ opacity: 0, y: -4 \}\}\s*animate=\{\{ opacity: 1, y: 0 \}\}\s*transition=\{\{ duration: 0\.15, ease: EASE_OUT \}\}/);
  assert.match(nav, /has-\[a:hover\]:border-white\/30/);
});
