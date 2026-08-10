import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Help, Settings and the account menu moved out of the sidebar footer to the
 * top-right, which returns the footer's height to the nav — the thing that runs
 * out of room as modules are added.
 *
 * The risk in a move like this is not that it looks wrong. It is that a control
 * becomes unreachable on one breakpoint, or that the two placements drift into
 * two different menus.
 */

test("the cluster is defined once and used by both bars", () => {
  // Two copies of a menu containing "Sign out" is the kind of thing that drifts:
  // one gains an item and the other quietly does not.
  const shell = src("src/components/AppShell.tsx");
  assert.equal((shell.match(/function AccountCluster\(/g) ?? []).length, 1);
  assert.equal((shell.match(/<AccountCluster /g) ?? []).length, 2, "desktop bar and mobile header");

  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /Sign out/);
  assert.doesNotMatch(shell, /Sign out/, "the shell must not carry a second copy of the menu");
});

test("the account menu is reachable on every breakpoint", () => {
  const shell = src("src/components/AppShell.tsx");
  const desktopBar = shell.slice(shell.indexOf("{/* Desktop top bar"), shell.indexOf("{/* Mobile drawer */}"));
  const mobileBar = shell.slice(shell.indexOf("{/* Mobile top bar"), shell.indexOf("{/* Desktop top bar"));

  // Desktop: shown only at lg, because the mobile header covers the rest.
  assert.match(desktopBar, /hidden h-14 items-center[^"]*lg:flex/);
  assert.match(desktopBar, /<AccountCluster /);
  // Mobile: the same cluster, on the header that already existed.
  assert.match(mobileBar, /lg:hidden/);
  assert.match(mobileBar, /<AccountCluster /);
});

test("the sidebar footer is gone, not merely hidden", () => {
  // Leaving it rendered would keep the height it was taking, which is the whole
  // point of the move.
  const shell = src("src/components/AppShell.tsx");
  const sidebar = shell.slice(shell.indexOf("function SidebarInner("), shell.indexOf("export default function AppShell"));
  assert.doesNotMatch(sidebar, /Help, Settings & user/);
  assert.doesNotMatch(sidebar, /<SidebarHelpSettings/, "the sidebar no longer carries these");
  assert.doesNotMatch(sidebar, /<AccountMenu/);
  // The nav keeps its scroll region, which is what gains the space.
  assert.match(sidebar, /flex-1 overflow-y-auto/);
});

test("the page reserves the height the fixed bar takes", () => {
  // A fixed bar over unpadded content hides the first rows of every page.
  const shell = src("src/components/AppShell.tsx");
  assert.match(shell, /fixed left-60 right-0 top-0 z-30[^"]*h-14/, "bar is fixed, and to the right of the sidebar");
  assert.match(shell, /lg:pt-19/, "content clears it");
});

test("ClockWeather moved rather than being duplicated or dropped", () => {
  const shell = src("src/components/AppShell.tsx");
  assert.equal((shell.match(/<ClockWeather /g) ?? []).length, 1, "exactly one instance");
  const desktopBar = shell.slice(shell.indexOf("{/* Desktop top bar"), shell.indexOf("{/* Mobile drawer */}"));
  assert.match(desktopBar, /<ClockWeather cities=\{weatherCities\}/, "and it lives in the bar now");
});

test("the compact variant is a trigger change, not a second menu", () => {
  // The panels must stay identical — only the trigger and the side they open
  // from differ, because a bar at the top cannot open a menu upwards.
  const help = src("src/components/SidebarHelpSettings.tsx");
  assert.match(help, /compact \? ICON_TRIGGER : ROW/);
  assert.match(help, /const panelSide = compact \? "bottom" : "right"/);
  assert.equal((help.match(/side=\{panelSide\}/g) ?? []).length, 2, "Help and Settings panels both");

  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /side=\{compact \? "bottom" : "top"\}/);
});

test("an avatar-only trigger still says who you are", () => {
  // The sidebar showed the name next to the avatar. Behind an avatar alone it
  // has to be in the menu, or you cannot tell which account you are signed into.
  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /aria-label=\{`Account — \$\{user\.name\}`\}/);
  const compactHeader = menu.slice(menu.indexOf("{compact && ("), menu.indexOf("v{APP_VERSION}"));
  assert.match(compactHeader, /\{user\.name\}/);
  assert.match(compactHeader, /\{user\.role\}/);
  // The icon-only Help/Settings triggers need names too.
  const help = src("src/components/SidebarHelpSettings.tsx");
  assert.match(help, /aria-label=\{compact \? "Help" : undefined\}/);
  assert.match(help, /aria-label=\{compact \? "Settings" : undefined\}/);
});
