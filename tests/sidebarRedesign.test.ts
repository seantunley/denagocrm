import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allNavLinks, buildNav } from "../src/components/nav-config";

/**
 * The sidebar redesign (2026-11-12; the "Denago CRM — sidebar redesign" canvas
 * and sidebar-reorganisation-plan.md). Only WHERE a link sits changed: every
 * person sees exactly the links they saw before.
 */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const PERSONAS: Record<string, { admin: boolean; perms: string[] }> = {
  owner: { admin: true, perms: [] },
  sales: { admin: false, perms: ["leads.view_owned", "quotes.view_owned", "contacts.view_owned", "activities.view", "documents.view_owned", "documents.upload", "signing.view", "inbox.view"] },
  workshop: { admin: false, perms: ["jobcards.view_all", "vehicles.view_all", "activities.view", "parts.view", "warranty.view", "cases.view_owned"] },
  marketing: { admin: false, perms: ["campaigns.view", "surveys.view", "referrals.view", "library.view"] },
  manager: { admin: false, perms: ["reports.view", "forecast.view", "deliveries.view", "stock.view", "fleets.view", "audit.view", "journeys.manage", "docbuilder.view", "leads.view_all"] },
  nobody: { admin: false, perms: [] },
};

/** What buildNav on main (d9ae92b5) showed each persona, before the redesign. */
const BEFORE: Record<string, string[]> = {
  owner: ["/", "/activities", "/assistant", "/audit", "/birthdays", "/bot-builder", "/calendar", "/cases", "/chatbot", "/competitors", "/contacts", "/d/home", "/data-quality", "/deliveries", "/document-studio", "/documents", "/fleets", "/forecast", "/health", "/inbox", "/invoices", "/jobcards", "/jobcards/insights", "/journeys", "/leads", "/marketing/audiences", "/marketing/calendar", "/marketing/campaigns", "/marketing/overview", "/marketing/surveys", "/marketing/surveys/insights", "/marketing/templates", "/parts", "/quotes", "/referrals", "/repairs", "/reports", "/service-due", "/signatures", "/stock", "/targets", "/test-drives", "/today", "/vehicles", "/warranty", "/workshop-calendar"],
  sales: ["/", "/activities", "/assistant", "/birthdays", "/calendar", "/contacts", "/d/home", "/data-quality", "/documents", "/health", "/inbox", "/leads", "/quotes", "/signatures", "/test-drives", "/today"],
  workshop: ["/", "/activities", "/assistant", "/calendar", "/cases", "/d/home", "/jobcards", "/jobcards/insights", "/parts", "/service-due", "/test-drives", "/vehicles", "/warranty", "/workshop-calendar"],
  marketing: ["/", "/d/home", "/documents", "/marketing/audiences", "/marketing/calendar", "/marketing/campaigns", "/marketing/overview", "/marketing/surveys", "/marketing/surveys/insights", "/marketing/templates", "/referrals"],
  manager: ["/", "/assistant", "/audit", "/d/home", "/deliveries", "/document-studio", "/fleets", "/forecast", "/invoices", "/journeys", "/leads", "/reports", "/stock", "/targets", "/today"],
  nobody: ["/", "/d/home"],
};

test("every person sees exactly the links they saw before — none gained, none lost", () => {
  for (const [name, persona] of Object.entries(PERSONAS)) {
    const after = allNavLinks(buildNav(persona.admin, persona.perms)).map((link) => link.href).sort();
    assert.deepEqual(after, BEFORE[name], name);
  }
});

test("pinned, then the groups in the order work happens, with Ask the CRM in the footer", () => {
  const nav = buildNav(true, []);
  assert.deepEqual(nav.topLinks.map((link) => link.label), ["Home", "Today", "Inbox", "Help desk", "Calendar"]);
  assert.deepEqual(nav.groups.map((group) => group.label), ["Sales", "Customers", "Service", "Marketing", "Insights", "Automation", "Admin"]);
  const labels = (key: string) => nav.groups.find((group) => group.key === key)?.links.map((link) => link.label);
  assert.deepEqual(labels("sales"), ["Leads", "Quotes", "Test Drives", "Signatures", "Deliveries", "Invoices", "Stock"]);
  assert.deepEqual(labels("customers"), ["Contacts", "Fleets", "Activities", "Customer Health", "Birthdays", "Documents"]);
  assert.deepEqual(labels("service"), ["Workshop calendar", "Job Cards", "Vehicles", "Service Due", "Warranty", "Parts"]);
  assert.deepEqual(labels("insights"), ["Dashboards", "Reports", "Targets", "Forecast", "Workshop Insights", "Competitors"]);
  assert.deepEqual(labels("admin"), ["Document Studio", "Data quality", "Audit log", "Data repairs"]);
  assert.deepEqual(nav.footerLinks.map((link) => link.label), ["Ask the CRM"]);
  for (const group of nav.groups) assert.ok(group.icon, `${group.label} has its heading icon`);
  // Old names still find the renamed links.
  const all = allNavLinks(nav);
  assert.ok(all.find((link) => link.href === "/workshop-calendar")?.keywords?.includes("workshop cal"));
  assert.ok(all.find((link) => link.href === "/repairs")?.keywords?.includes("repairs"));
  // Custom names for leads and job cards still apply.
  const named = buildNav(true, [], undefined, { "/leads": "Enquiries", "/jobcards": "Work orders" });
  assert.ok(allNavLinks(named).some((link) => link.label === "Enquiries"));
  assert.ok(allNavLinks(named).some((link) => link.label === "Work orders"));
});

test("a workspace without a pack loses those links, never leaving an empty group", () => {
  for (const enabled of [new Set<string>(), new Set(["commerce"]), new Set(["automotive"]), new Set(["marketing", "support"])]) {
    for (const group of buildNav(true, [], enabled).groups) assert.ok(group.links.length > 0, `${group.key} with ${[...enabled].join(",") || "nothing"}`);
  }
});

test("search and the palette list the footer's Ask the CRM; the palette also matches old names", () => {
  assert.match(src("src/lib/search-destinations.ts"), /\.\.\.\[\.\.\.topLinks, \.\.\.footerLinks\]\.map/);
  const palette = src("src/components/CommandMenu.tsx");
  assert.match(palette, /const topLinks = \[\.\.\.nav\.topLinks, \.\.\.nav\.footerLinks\];/);
  assert.match(palette, /value=\{`\$\{group\.label\} \$\{link\.label\} \$\{link\.keywords\?\.join\(" "\) \?\? ""\}`\}/);
});

test("the look: one group open at a time, the page's group opens on arrival; a 72px rail with flyouts; 44px rows for touch", () => {
  const nav = src("src/components/Nav.tsx");
  assert.match(nav, /const open = choice\?\.page === pathname \? choice\.open : activeGroup;/);
  assert.match(nav, /aria-expanded=\{expanded\}/, "group headings are real buttons with their state");
  assert.match(nav, /const hidden = expanded \? 0 : groupTotal\(group\);/, "a closed group still shows its counts");
  assert.match(nav, /const ROW = "min-h-11 pointer-fine:min-h-9 rounded-\[10px\]";/);
  assert.match(nav, /<Popover open=\{open\} onOpenChange=\{setOpen\}>/);
  assert.match(nav, /onMouseEnter=\{show\}\s*onMouseLeave=\{hide\}/);
  const shell = src("src/components/AppShell.tsx");
  assert.match(shell, /\$\{rail \? "w-\[72px\]" : "w-70"\}/);
  assert.match(shell, /const offset = rail \? "lg:left-\[72px\]" : "lg:left-70";/, "the top bar and page start where the sidebar ends");
  assert.match(shell, /Search or jump to…/);
  assert.match(shell, /localStorage\.setItem\(RAIL_KEY/);
});
