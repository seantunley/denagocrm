import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_ICON_SIZES, MASKABLE_ICON_PADDING, appIconSize, appIconUrl, brandIconAsset, logoBacking } from "../src/lib/appIcon";
import { installedAppIcons } from "../src/lib/installedApp";

// Sean, 2026-11-24: the tab icon "is not updated per tenant"; the platform's fallback was Denago's "D".
const code = (path: string) => readFileSync(path, "utf8");
const brand = { tenantId: "t1", iconRef: "branding/t1/icon-1795000000000.png", logoRef: "branding/t1/logo-1700000000000.png" };

test("a workspace's icon URL names it, its size, maskable or not, and changes when the icon does", () => {
  assert.equal(appIconUrl(brand, 192), "/api/brand/icon/t1?s=192&v=icon-1795000000000.png");
  assert.equal(appIconUrl(brand, 512, true), "/api/brand/icon/t1?s=512&m=1&v=icon-1795000000000.png");
  assert.equal(appIconUrl({ ...brand, iconRef: null }, 180), "/api/brand/icon/t1?s=180&v=logo-1700000000000.png");
  assert.equal(appIconUrl({ tenantId: null, logoRef: null }, 192), "/icons/icon-192.png");
  assert.equal(appIconSize("9999"), 192);
  assert.deepEqual([...APP_ICON_SIZES], [180, 192, 512]);
  assert.equal(brandIconAsset("branding/t1/../other/icon-1795000000000.png"), "icon-1795000000000.png");
  assert.equal(brandIconAsset("branding/t1/logo-1700000000000.png"), null, "only an icon-<stamp> file is an icon");
  assert.equal(logoBacking(0.9), "#0f172a");
  assert.equal(logoBacking(0.1), "#ffffff");
});

test("the installed app lists both maskable sizes for a workspace (review of #1221)", () => {
  const icons = installedAppIcons({ ...brand, displayName: "W", tagline: null, primary: null, primaryForeground: null }, []);
  const maskable = icons.filter((icon) => "purpose" in icon && icon.purpose === "maskable").map((icon) => icon.sizes);
  assert.deepEqual(maskable, ["192x192", "512x512"]);
  assert.ok(icons.every((icon) => icon.src.startsWith("/api/brand/icon/t1?")));
});

test("an uploaded icon's maskable form keeps the art inside the safe circle (review of #1221)", () => {
  const route = code("src/app/api/brand/icon/[tenantId]/route.ts");
  assert.match(route, /maskable \? await onSquare\(bytes, size, MASKABLE_ICON_PADDING\) : await sharp\(bytes\)/);
  assert.equal(MASKABLE_ICON_PADDING, 0.1, "the middle 80% a launcher keeps");
});

test("only a square icon is accepted — a wide picture would be cropped without warning (review of #1221)", () => {
  const action = code("src/app/actions/workspaceIcon.ts");
  assert.match(action, /if \(meta\.width !== meta\.height\) throw new ActionRefusal\(`The icon must be square/);
  assert.match(action, /if \(meta\.width < 192\) throw new ActionRefusal/);
});
