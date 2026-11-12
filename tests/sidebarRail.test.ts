import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  assert.match(group, /<Popover open=\{open\} onOpenChange=\{setOpen\}>/, "Radix: Escape and clicking away close it; focus returns to the icon");
  assert.match(group, /onMouseEnter=\{show\}\s*onMouseLeave=\{hide\}/);
  assert.match(group, /onMouseEnter=\{hold\}\s*onMouseLeave=\{hide\}/, "moving into the flyout keeps it open");
  assert.match(group, /className="depth-float w-60 rounded-\[14px\] border-0 bg-\[var\(--depth-float\)\] p-2 motion-reduce:animate-none"/);
  assert.match(src("src/components/ui/popover.tsx"), /data-\[state=open\]:zoom-in-95/, "scales up from its icon (transform origin from Radix)");
  assert.match(src("src/app/globals.css"), /--depth-float-shadow: [^;]*0 28px 56px -12px oklch\(0 0 0 \/ 75%\)/);
});
