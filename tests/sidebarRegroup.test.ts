import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allNavLinks, buildNav } from "../src/components/nav-config";

/**
 * Sidebar regroup (sidebar-implementation-brief.md, PR 1, 2026-11-12). Only
 * WHERE a link sits changed: every person sees exactly the links they saw before.
 */
const SALES = ["leads.view_owned", "quotes.view_owned", "contacts.view_owned", "activities.view", "documents.view_owned", "documents.upload", "signing.view", "inbox.view"];
const PERSONAS: Record<string, { admin: boolean; perms: string[]; enabled?: Set<string> }> = {
  owner: { admin: true, perms: [] },
  sales: { admin: false, perms: SALES },
  workshop: { admin: false, perms: ["jobcards.view_all", "vehicles.view_all", "activities.view", "parts.view", "warranty.view", "cases.view_owned"] },
  marketing: { admin: false, perms: ["campaigns.view", "surveys.view", "referrals.view", "library.view"] },
  manager: { admin: false, perms: ["reports.view", "forecast.view", "deliveries.view", "stock.view", "fleets.view", "audit.view", "journeys.manage", "docbuilder.view", "leads.view_all"] },
  nobody: { admin: false, perms: [] },
  ownerNoModules: { admin: true, perms: [], enabled: new Set() },
  salesNoModules: { admin: false, perms: SALES, enabled: new Set() },
};

/** What buildNav on main (d9ae92b5) showed each persona, before the regroup. */
const BEFORE: Record<string, string[]> = {
  owner: ["/", "/activities", "/assistant", "/audit", "/birthdays", "/bot-builder", "/calendar", "/cases", "/chatbot", "/competitors", "/contacts", "/d/home", "/data-quality", "/deliveries", "/document-studio", "/documents", "/fleets", "/forecast", "/health", "/inbox", "/invoices", "/jobcards", "/jobcards/insights", "/journeys", "/leads", "/marketing/audiences", "/marketing/calendar", "/marketing/campaigns", "/marketing/overview", "/marketing/surveys", "/marketing/surveys/insights", "/marketing/templates", "/parts", "/quotes", "/referrals", "/repairs", "/reports", "/service-due", "/signatures", "/stock", "/targets", "/test-drives", "/today", "/vehicles", "/warranty", "/workshop-calendar"],
  sales: ["/", "/activities", "/assistant", "/birthdays", "/calendar", "/contacts", "/d/home", "/data-quality", "/documents", "/health", "/inbox", "/leads", "/quotes", "/signatures", "/test-drives", "/today"],
  workshop: ["/", "/activities", "/assistant", "/calendar", "/cases", "/d/home", "/jobcards", "/jobcards/insights", "/parts", "/service-due", "/test-drives", "/vehicles", "/warranty", "/workshop-calendar"],
  marketing: ["/", "/d/home", "/documents", "/marketing/audiences", "/marketing/calendar", "/marketing/campaigns", "/marketing/overview", "/marketing/surveys", "/marketing/surveys/insights", "/marketing/templates", "/referrals"],
  manager: ["/", "/assistant", "/audit", "/d/home", "/deliveries", "/document-studio", "/fleets", "/forecast", "/invoices", "/journeys", "/leads", "/reports", "/stock", "/targets", "/today"],
  nobody: ["/", "/d/home"],
  ownerNoModules: ["/", "/activities", "/audit", "/birthdays", "/calendar", "/contacts", "/d/home", "/data-quality", "/document-studio", "/documents", "/forecast", "/health", "/leads", "/quotes", "/repairs", "/reports", "/signatures", "/targets", "/today"],
  salesNoModules: ["/", "/activities", "/birthdays", "/calendar", "/contacts", "/d/home", "/data-quality", "/documents", "/health", "/leads", "/quotes", "/signatures", "/today"],
};

test("every person sees exactly the links they saw before — none gained, none lost", () => {
  for (const [name, persona] of Object.entries(PERSONAS)) {
    const after = allNavLinks(buildNav(persona.admin, persona.perms, persona.enabled)).map((link) => link.href).sort();
    assert.deepEqual(after, BEFORE[name], name);
  }
});

test("pinned, then the groups in the order work happens", () => {
  const nav = buildNav(true, []);
  assert.deepEqual(nav.topLinks.map((link) => link.label), ["Home", "Today", "Inbox", "Help desk", "Calendar"]);
  assert.deepEqual(nav.groups.map((group) => group.key), ["sales", "customers", "service", "marketing", "insights", "automation", "admin"]);
  const labels = (key: string) => nav.groups.find((group) => group.key === key)?.links.map((link) => link.label);
  assert.deepEqual(labels("sales"), ["Leads", "Quotes", "Test Drives", "Signatures", "Deliveries", "Invoices", "Stock"]);
  assert.deepEqual(labels("customers"), ["Contacts", "Fleets", "Activities", "Customer Health", "Birthdays", "Documents"]);
  assert.deepEqual(labels("service"), ["Workshop calendar", "Job Cards", "Vehicles", "Service Due", "Warranty", "Parts"]);
  assert.deepEqual(labels("marketing"), ["Overview", "Campaigns", "Audiences", "Templates", "Calendar", "Surveys", "Survey insights", "Referrals"]);
  assert.deepEqual(labels("insights"), ["Dashboards", "Reports", "Targets", "Forecast", "Workshop Insights", "Competitors", "Ask the CRM"]);
  assert.deepEqual(labels("automation"), ["Journeys", "Chatbot", "Flow builder"]);
  assert.deepEqual(labels("admin"), ["Document Studio", "Data quality", "Audit log", "System repairs"]);
});

test("renamed links are still found by their old names; custom names for leads and job cards still apply", () => {
  const all = allNavLinks(buildNav(true, []));
  assert.ok(all.find((link) => link.href === "/workshop-calendar")?.keywords?.includes("workshop cal"));
  assert.ok(all.find((link) => link.href === "/repairs")?.keywords?.includes("repairs"));
  const named = allNavLinks(buildNav(true, [], undefined, { "/leads": "Enquiries", "/jobcards": "Work orders" }));
  assert.ok(named.some((link) => link.label === "Enquiries"));
  assert.ok(named.some((link) => link.label === "Work orders"));
});

test("no group ever renders empty, whatever the role or the workspace's packs", () => {
  const packs = [undefined, new Set<string>(), new Set(["commerce"]), new Set(["automotive"]), new Set(["marketing", "support"])];
  for (const persona of Object.values(PERSONAS)) {
    for (const enabled of packs) {
      for (const group of buildNav(persona.admin, persona.perms, enabled).groups) assert.ok(group.links.length > 0, group.key);
    }
  }
});

test("Ask the CRM is the button at the foot of the sidebar — drawn there, still in its group for search and permissions", () => {
  const foot = allNavLinks(buildNav(true, [])).filter((link) => link.foot);
  assert.deepEqual(foot.map((link) => link.href), ["/assistant"]);
  const nav = readFileSync("src/components/Nav.tsx", "utf8");
  // Taken out of its group AFTER the phone filter, so the phone menu never gains it.
  assert.match(nav, /const footLinks = scoped\.flatMap\(\(group\) => group\.links\.filter\(\(link\) => link\.foot\)\);/);
  assert.match(nav, /links: group\.links\.filter\(\(link\) => !link\.foot\)/);
  // Outside the scrolling list, so it stays put however long the menu is.
  assert.match(nav, /<\/div>\s*\{\/\* The foot of the sidebar/);
});
