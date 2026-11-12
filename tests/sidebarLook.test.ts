import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Sidebar brief PR 2 — the new look with subtle depth (canvas board "Sidebar —
 * with subtle depth"), keeping the decisions already in the code: the logo
 * image, Help/Settings/account top-right.
 */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const css = src("src/app/globals.css");
const nav = src("src/components/Nav.tsx");
const shell = src("src/components/AppShell.tsx");
const sidebar = shell.slice(shell.indexOf("function SidebarInner("), shell.indexOf("export default function AppShell"));

test("depth is tokens, applied by utilities — no recipe hard-coded in a component", () => {
  for (const token of ["--depth-raised:", "--depth-raised-shadow:", "--depth-inset:", "--depth-inset-shadow:", "--depth-float:", "--depth-float-shadow:", "--depth-sheet-shadow:"]) {
    assert.ok(css.includes(token), token);
  }
  assert.match(css, /@utility depth-raised \{\s*background-color: var\(--depth-raised\);\s*background-image: var\(--depth-raised-sheen\);\s*box-shadow: var\(--depth-raised-shadow\);/);
  assert.match(css, /@utility depth-inset \{\s*background-color: var\(--depth-inset\);\s*box-shadow: var\(--depth-inset-shadow\);/);
  assert.match(css, /--sidebar: oklch\(0\.14 0\.004 264\);/, "the sidebar is the lowest surface, a shade darker");
  assert.doesNotMatch(nav, /box-shadow|oklch\(/, "the menu uses the utilities, not raw values");
});

test("where you are is a raised pill; the pinned icon takes the accent; links in a group are text on a guide line", () => {
  // The pill: depth-raised behind the current link (since PR 3 it glides between links).
  assert.match(nav, /className="depth-raised absolute inset-0 -z-10 rounded-\[10px\]"/);
  assert.match(nav, /const RAISED = "font-semibold text-sidebar-accent-foreground";/);
  assert.match(nav, /<link\.icon className=\{cn\("size-\[18px\] shrink-0", active && "text-primary"\)\}/);
  assert.match(nav, /className="ml-5 flex flex-col gap-0\.5 border-l border-white\/\[0\.12\] pl-\[9px\]/);
  // ChildLink has no icon.
  const child = nav.slice(nav.indexOf("function ChildLink("));
  assert.doesNotMatch(child, /link\.icon/);
  assert.match(nav, /const ROW = "min-h-11 pointer-fine:min-h-9 rounded-\[10px\]";/, "36px under a mouse, 44px on touch");
});

test("one group open at a time; the page's group opens on arrival; headings are real buttons; closed groups keep their counts", () => {
  assert.match(nav, /const open = choice\?\.page === pathname \? choice\.open : activeGroup;/);
  assert.match(nav, /<button\s+type="button"\s+aria-expanded=\{expanded\}\s+aria-controls=\{panelId\}/);
  assert.match(nav, /const hidden = expanded \? 0 : groupTotal\(group\);/);
});

test("counts: the accent, a light top edge, a drop shadow and dark digits", () => {
  assert.match(nav, /bg-primary depth-sheen px-1\.5 text-xs font-bold tabular-nums text-\[#1a0d05\]/);
});

test("the search is an inset well with a raised key; the logo and the top-right menus stay", () => {
  assert.match(sidebar, /className="depth-inset flex min-h-11/);
  assert.match(sidebar, /<kbd className="depth-key/);
  assert.match(sidebar, /<BrandLogo/, "the brand is the workspace's logo image");
  assert.doesNotMatch(sidebar, /<SidebarHelpSettings|<AccountMenu/, "Help, Settings and the account stay top-right");
  assert.match(src("src/components/QuickActions.tsx"), /rounded-\[10px\] bg-primary depth-sheen/, "Quick actions restyled, not rebuilt");
});

test("the page is a sheet on the sidebar: rounded corner, inner edge, shadow at the join, no hard border", () => {
  assert.match(shell, /fixed bottom-0 right-0 top-2\.5 -z-20 hidden rounded-tl-\[18px\] bg-background depth-sheet lg:block \$\{offset\}/);
  assert.match(shell, /<aside className=\{`fixed inset-y-0 left-0 z-40 hidden lg:flex lg:flex-col \$\{rail \? "w-\[72px\]" : "w-70"\}`\}>/, "no border between sidebar and page");
  // A sticky bar under the top bar moves down with it.
  assert.match(src("src/components/CalendarWorkspace.tsx"), /sticky top-14[^"]*lg:top-\[66px\]/);
});
