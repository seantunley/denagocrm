import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FLYOUT_CLOSED, flyoutTakesFocus, railFlyout, type FlyoutEvent, type FlyoutState } from "../src/lib/railFlyout";

const play = (...events: FlyoutEvent[]): FlyoutState => events.reduce(railFlyout, FLYOUT_CLOSED);

// Review of #1081: hover and click fought — hovering opened the flyout and the
// click that followed toggled it shut; and a hover opening took keyboard focus.
test("hover, then click the same icon: the flyout STAYS open, and only now takes focus", () => {
  const hovered = play("pointer-enter");
  assert.deepEqual(hovered, { open: true, via: "hover" });
  assert.equal(flyoutTakesFocus(hovered), false, "hovering never steals focus");
  const clicked = railFlyout(hovered, "click");
  assert.deepEqual(clicked, { open: true, via: "click" }, "the click keeps it open");
  assert.equal(flyoutTakesFocus(clicked), true);
  // A click-opened flyout stays when the pointer wanders off (keyboard and click users), and a second click closes it.
  assert.deepEqual(railFlyout(clicked, "pointer-leave"), clicked);
  assert.deepEqual(railFlyout(clicked, "click"), FLYOUT_CLOSED);
});

test("keyboard or click on a closed icon opens it with focus; hover alone opens and closes without it", () => {
  const byKey = play("click"); // Enter/Space click a <button>
  assert.deepEqual(byKey, { open: true, via: "click" });
  assert.equal(flyoutTakesFocus(byKey), true);
  assert.deepEqual(play("pointer-enter", "pointer-leave"), FLYOUT_CLOSED, "leaving closes a hover-opened flyout");
  assert.deepEqual(play("pointer-enter", "pointer-enter"), { open: true, via: "hover" });
  // Escape or clicking away closes it however it opened.
  assert.deepEqual(play("click", "dismiss"), FLYOUT_CLOSED);
  assert.deepEqual(play("pointer-enter", "dismiss"), FLYOUT_CLOSED);
});

test("the icon follows those rules: an anchor, not Radix's toggling trigger; focus only for click/key; focus back on close", () => {
  const nav = readFileSync("src/components/Nav.tsx", "utf8").replace(/\r\n/g, "\n");
  const group = nav.slice(nav.indexOf("function RailGroup("), nav.indexOf("function ChildLink("));
  assert.match(group, /<PopoverAnchor asChild>/);
  assert.doesNotMatch(group, /PopoverTrigger/, "Radix's own click toggle would fight the rules");
  assert.match(group, /onClick=\{\(\) => \{\s*hold\(\);\s*send\("click"\);\s*\}\}/);
  // Focus only when a click/key opening starts — never on hover; Radix's own auto-focus (which skips links) is off.
  assert.match(group, /if \(flyoutTakesFocus\(next\) && !flyoutTakesFocus\(previous\)\) \{\s*requestAnimationFrame\(\(\) => panel\.current\?\.querySelector<HTMLElement>\("a"\)\?\.focus\(\)\);/);
  assert.match(group, /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(group, /if \(lastVia\.current === "click"\) button\.current\?\.focus\(\);/);
  assert.match(group, /onInteractOutside=\{\(event\) => \{\s*if \(button\.current\?\.contains\(event\.target as Node\)\) event\.preventDefault\(\);/);
  assert.match(group, /aria-expanded=\{open\}/);
});

/** Sidebar brief PR 4 — the collapsed rail. */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const nav = src("src/components/Nav.tsx");
const shell = src("src/components/AppShell.tsx");

test("a collapse button in the sidebar header; the choice is remembered per browser; desktop only", () => {
  assert.match(shell, /aria-label=\{rail \? "Expand sidebar" : "Collapse sidebar"\}/);
  assert.match(shell, /const RAIL_KEY = "denago-sidebar-rail";/);
  assert.match(shell, /localStorage\.setItem\(RAIL_KEY, on \? "1" : "0"\)/);
  assert.match(shell, /if \(localStorage\.getItem\(RAIL_KEY\) === "1"\) setRail\(true\);/);
  // The drawer (phone) is rendered without onToggleRail, so it never becomes a rail.
  assert.match(shell, /brand=\{brand\} phone \/>/);
  assert.match(shell, /rail=\{rail\} fading=\{fading\} onToggleRail=\{toggleRail\} \/>/);
});

test("collapsing: the labels fade out before the width closes — no fade to wait for under reduced motion", () => {
  assert.match(shell, /setFading\(true\);\s*fadeTimer\.current = setTimeout\(\(\) => \{\s*setRail\(true\);\s*setFading\(false\);\s*\}, 100\);/);
  assert.match(shell, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(shell, /transition-opacity duration-100 motion-reduce:transition-none \$\{fading \? "opacity-0" : "opacity-100"\}/);
});

test("the rail: 72px, pinned icons with tooltips, one icon per group, counts on the icons", () => {
  assert.match(shell, /\$\{rail \? "w-\[72px\]" : "w-70"\}/);
  const rail = nav.slice(nav.indexOf("if (rail) {"), nav.indexOf("\n  return (\n    <MotionConfig"));
  assert.match(rail, /<RailTip key=\{link\.href\} label=\{link\.label\}>/);
  assert.match(rail, /\{n > 0 && <RailCount n=\{n\} \/>\}/);
  assert.match(rail, /<RailGroup key=\{group\.key\}/);
  assert.match(nav, /<TooltipContent side="right" sideOffset=\{10\}>/);
});

test("a group's flyout: hover or click, Escape, leaving, keyboard; the top depth level, scaling up from its icon", () => {
  const group = nav.slice(nav.indexOf("function RailGroup("), nav.indexOf("function ChildLink("));
  assert.match(group, /<Popover open=\{open\} onOpenChange=\{\(next\) => !next && send\("dismiss"\)\}>/, "Radix: Escape and clicking away close it");
  assert.match(group, /onMouseEnter=\{enter\}\s*onMouseLeave=\{leave\}/);
  assert.match(group, /onMouseEnter=\{hold\}\s*onMouseLeave=\{leave\}/, "moving into the flyout keeps it open");
  assert.match(group, /className="depth-float w-60 rounded-\[14px\] border-0 bg-\[var\(--depth-float\)\] p-2 motion-reduce:animate-none"/);
  assert.match(src("src/components/ui/popover.tsx"), /data-\[state=open\]:zoom-in-95/, "scales up from its icon (transform origin from Radix)");
  assert.match(src("src/app/globals.css"), /--depth-float-shadow: [^;]*0 28px 56px -12px oklch\(0 0 0 \/ 75%\)/);
});
