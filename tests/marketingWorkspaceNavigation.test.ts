import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketingWorkspaceSections } from "../src/components/marketing/marketing-workspace-nav";

function hrefs(isAdmin: boolean, permissions: string[]) {
  return buildMarketingWorkspaceSections(isAdmin, permissions).map((section) => section.href);
}

test("campaign-only users do not see survey workspace navigation", () => {
  const links = hrefs(false, ["campaigns.view"]);

  assert.ok(links.includes("/marketing/campaigns"));
  assert.ok(!links.includes("/marketing/surveys"));
});

test("survey-only users do not see campaign workspace navigation", () => {
  const links = hrefs(false, ["surveys.manage"]);

  assert.ok(links.includes("/marketing/surveys"));
  assert.ok(!links.includes("/marketing/campaigns"));
  assert.ok(!links.includes("/marketing/audiences"));
  assert.ok(!links.includes("/marketing/templates"));
});

test("owners see every top-level marketing workspace section", () => {
  assert.deepEqual(new Set(hrefs(true, [])), new Set([
    "/marketing/overview",
    "/marketing/campaigns",
    "/marketing/calendar",
    "/marketing/audiences",
    "/marketing/templates",
    "/marketing/surveys",
  ]));
});
