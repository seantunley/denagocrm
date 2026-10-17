import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { linkOnPhone, onPhone } from "../src/lib/phoneScope";
import { buildNav } from "../src/components/nav-config";

test("the phone keeps sales, the workshop, the help desk and deliveries (Sean, 2026-10-17)", () => {
  for (const path of ["/", "/today", "/leads", "/leads/abc", "/deals/abc", "/contacts", "/contacts/abc/edit", "/quotes", "/quotes/abc", "/calendar", "/activities", "/test-drives", "/inbox", "/signatures", "/jobcards", "/jobcards/abc", "/vehicles", "/workshop-calendar", "/service-due", "/cases", "/deliveries", "/search", "/help"]) {
    assert.equal(onPhone(path), true, path);
  }
});

test("everything else is for a computer — automation, marketing, reports, stock, governance", () => {
  for (const path of ["/journeys", "/automations", "/assistant", "/chatbot", "/bot-builder", "/marketing/campaigns", "/campaigns", "/reports", "/d/home", "/targets", "/forecast", "/stock", "/parts", "/warranty", "/fleets", "/health", "/documents", "/document-studio", "/audit", "/repairs", "/competitors", "/jobcards/insights", "/products", "/trash"]) {
    assert.equal(onPhone(path), false, path);
  }
  // No accidental prefix match: /leadsboard is not /leads.
  assert.equal(onPhone("/leadsx"), false);
});

test("settings on a phone: the person's own account only", () => {
  assert.equal(onPhone("/settings", "account"), true);
  assert.equal(onPhone("/settings", "notifications"), true);
  assert.equal(onPhone("/settings"), false);
  assert.equal(onPhone("/settings", "team"), false);
  assert.equal(onPhone("/settings/company"), false);
  assert.equal(linkOnPhone("/settings?tab=account"), true);
  assert.equal(linkOnPhone("/settings?tab=email"), false);
});

test("the phone menu is the full menu filtered: no Automation, Marketing or Governance group", () => {
  const { topLinks, groups } = buildNav(true, []);
  const phoneGroups = groups.map((g) => ({ key: g.key, links: g.links.filter((l) => linkOnPhone(l.href)) })).filter((g) => g.links.length > 0);
  const keys = phoneGroups.map((g) => g.key);
  for (const gone of ["automation", "marketing", "governance", "platform", "stock"]) assert.ok(!keys.includes(gone), gone);
  assert.deepEqual(topLinks.filter((l) => linkOnPhone(l.href)).map((l) => l.href), ["/", "/today"]);
  const nav = readFileSync("src/components/Nav.tsx", "utf8");
  assert.match(nav, /built\.groups\.map\(\(group\) => \(\{ \.\.\.group, links: group\.links\.filter\(\(link\) => linkOnPhone\(link\.href\)\) \}\)\)\.filter\(\(group\) => group\.links\.length > 0\)/);
  const shell = readFileSync("src/components/AppShell.tsx", "utf8");
  assert.match(shell, /brand=\{brand\} phone \/>/, "the drawer is the phone menu");
  assert.match(shell, /<PhoneGate>\{children\}<\/PhoneGate>/);
});

test("a page outside it is not available on a phone — the notice, and no way through; no DAX button", () => {
  const gate = readFileSync("src/components/PhoneGate.tsx", "utf8");
  assert.match(gate, /className="md:hidden" data-testid="phone-notice"/);
  // "The desktop features must not be available" (Sean, 2026-10-17): no Open anyway.
  assert.doesNotMatch(gate, />\s*Open anyway\s*<|setOpenedAnyway|<button/);
  assert.match(gate, /<div className="max-md:hidden">\{children\}<\/div>/);
  assert.match(readFileSync("src/app/(app)/layout.tsx", "utf8"), /<div className="max-md:hidden"><AssistantBubble /);
});

test("the phone's bottom bar is the role's own places — no More", async () => {
  const { phoneRole } = await import("../src/lib/phoneScope");
  assert.equal(phoneRole({ sales: true, workshop: true, delivery: true }), "sales");
  assert.equal(phoneRole({ sales: false, workshop: true, delivery: true }), "workshop");
  assert.equal(phoneRole({ sales: false, workshop: false, delivery: true }), "delivery");
  assert.equal(phoneRole({ sales: false, workshop: false, delivery: false }), "other");
  const nav = readFileSync("src/components/MobileCompanionNav.tsx", "utf8");
  const phoneBar = nav.slice(nav.indexOf("{/* The phone (below 768px). */}"), nav.indexOf("{/* A tablet keeps the full bar"));
  assert.match(phoneBar, /md:hidden" aria-label="Primary navigation"/);
  assert.doesNotMatch(phoneBar, /onMore|More</, "no More on a phone");
  assert.match(nav, /role === "sales" \? \[places\.leads, places\.customers, places\.inbox\]/);
  assert.match(nav, /role === "workshop" \? \[places\.jobcards, places\.vehicles, tasks\]/);
  assert.match(nav, /role === "delivery" \? \[places\.deliveries, places\.customers, tasks\]/);
  // A tablet keeps the full bar.
  assert.match(nav, /hidden grid-cols-5[^"]*md:grid lg:hidden" aria-label="Primary navigation"/);
});

test("on a phone nothing offers a desktop page: Search, the account menu, the gear, Capture", () => {
  const menu = readFileSync("src/components/CommandMenu.tsx", "utf8");
  assert.match(menu, /if \(next\) setPhone\(window\.matchMedia\(PHONE_MEDIA\)\.matches\);/);
  for (const list of ["shownTopLinks", "shownGroups", "shownActions", "shownSettings"]) assert.match(menu, new RegExp(`\\{${list}\\.`), list);
  assert.match(menu, /hits\.filter\(\(hit\) => keep\(hit\.href\)\)/);
  assert.match(menu, /\{isAdmin && !phone && \(/);
  const account = readFileSync("src/components/AccountMenu.tsx", "utf8");
  assert.match(account, /<DropdownMenuItem asChild className="max-md:hidden">\s*<Link href="\/settings">/);
  assert.match(account, /<DropdownMenuItem asChild className="max-md:hidden">\s*<Link href="\/trash">/);
  assert.match(readFileSync("src/components/SidebarHelpSettings.tsx", "utf8"), /className=\{compact \? `\$\{triggerClass\} max-md:hidden` : triggerClass\} aria-label=\{compact \? "Settings" : undefined\}/);
  assert.match(readFileSync("src/components/AppShell.tsx", "utf8"), /aria-label="Search"\s+className="[^"]*md:hidden"/);
  assert.match(readFileSync("src/components/MobileCompanionNav.tsx", "utf8"), /<Link href="\/documents" className="[^"]*max-md:hidden">/);
});
