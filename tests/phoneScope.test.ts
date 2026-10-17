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

test("a page outside it says so on a phone, with Open anyway; the DAX button is hidden on a phone", () => {
  const gate = readFileSync("src/components/PhoneGate.tsx", "utf8");
  assert.match(gate, /className="md:hidden" data-testid="phone-notice"/);
  assert.match(gate, />\s*Open anyway\s*</);
  assert.match(gate, /<div className="max-md:hidden">\{children\}<\/div>/);
  assert.match(readFileSync("src/app/(app)/layout.tsx", "utf8"), /<div className="max-md:hidden"><AssistantBubble /);
});
