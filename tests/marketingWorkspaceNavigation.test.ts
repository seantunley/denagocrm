import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildMarketingWorkspaceSections } from "../src/components/marketing/marketing-workspace-nav";

function hrefs(isAdmin: boolean, permissions: string[]) {
  return buildMarketingWorkspaceSections(isAdmin, permissions).map((section) => section.href);
}

test("campaign-only users do not see survey workspace navigation", () => {
  const links = hrefs(false, ["campaigns.view"]);

  assert.ok(links.includes("/marketing/campaigns"));
  assert.ok(!links.includes("/marketing/surveys"));
  assert.ok(!links.includes("/marketing/surveys/insights"));
});

test("survey-only users do not see campaign workspace navigation", () => {
  const links = hrefs(false, ["surveys.manage"]);

  assert.ok(links.includes("/marketing/surveys"));
  assert.ok(links.includes("/marketing/surveys/insights"));
  assert.ok(!links.includes("/marketing/campaigns"));
  assert.ok(!links.includes("/marketing/audiences"));
  assert.ok(!links.includes("/marketing/templates"));
});

test("referral-only users see Referrals inside the marketing workspace", () => {
  const links = hrefs(false, ["referrals.view"]);

  assert.deepEqual(links, ["/referrals"]);
});

test("the Referrals route retains the marketing workspace shell", () => {
  const layout = readFileSync(
    new URL("../src/app/(app)/referrals/layout.tsx", import.meta.url),
    "utf8",
  );

  assert.match(layout, /<MarketingWorkspaceShell sections=\{sections\}>\{children\}<\/MarketingWorkspaceShell>/);
});

test("owners see every marketing workspace section", () => {
  assert.deepEqual(new Set(hrefs(true, [])), new Set([
    "/marketing/overview",
    "/marketing/campaigns",
    "/marketing/calendar",
    "/marketing/audiences",
    "/marketing/templates",
    "/marketing/surveys",
    "/marketing/surveys/insights",
    "/referrals",
  ]));
});
