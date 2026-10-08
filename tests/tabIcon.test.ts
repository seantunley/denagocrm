import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { PLATFORM_ICONS, brandIcons } from "../src/lib/tenantBrand";

/*
 * 2026-10-07: printed quotes opened with the black Vercel triangle as their tab
 * icon. Their HTML names no icon, so the browser asked for /favicon.ico — and
 * that was Next.js's stock file, never replaced. /favicon.ico is now a route
 * answering with the same icon the pages use: the workspace's logo, else the
 * platform's.
 */
const at = (rel: string) => new URL(`../${rel}`, import.meta.url);

test("the stock Vercel favicon is gone; /favicon.ico is the brand's icon", () => {
  assert.equal(statSync(at("src/app/favicon.ico")).isDirectory(), true, "a route folder, not the stock favicon file");
  const route = readFileSync(at("src/app/favicon.ico/route.ts"), "utf8");
  assert.match(route, /getActiveTenantId\(\)[\s\S]*brandForTenant\(id\)/, "the signed-in workspace first");
  assert.match(route, /brandForHost\(req\.headers\.get\("host"\)\)\.catch\(\(\) => DEFAULT_BRAND\)/, "then the domain, never throwing");
  assert.match(route, /NextResponse\.redirect\(new URL\(brandIcons\(brand\)\.icon, req\.url\), 307\)/);
});

test("the icon it answers with: the workspace logo, or the platform icon when there is none", () => {
  const unbranded = brandIcons({ tenantId: null, logoRef: null } as never);
  assert.equal(unbranded.icon, PLATFORM_ICONS.icon);
  assert.ok(existsSync(at(`public${PLATFORM_ICONS.icon}`)), "the platform icon file exists");
  const branded = brandIcons({ tenantId: "tenant_a", logoRef: "logo.png" } as never);
  assert.match(branded.icon, /^\/api\/brand\/logo\/tenant_a/);
});
