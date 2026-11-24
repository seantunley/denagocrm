import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { APP_ICON_SIZES, MASKABLE_ICON_PADDING, appIconSize, appIconUrl, brandIconAsset, logoBacking, logoPadding } from "../src/lib/appIcon";
import { onSquare } from "../src/lib/appIconDraw";
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

/**
 * Draws a picture with a mark in each of its four corners through onSquare, then reports how many non-backdrop pixels
 * fall OUTSIDE the maskable safe circle (radius 40% of the canvas) and how many marks show inside it.
 */
async function maskTest(padding: number, opaque: boolean) {
  const S = 512;
  const mark = { r: 220, g: 30, b: 30, alpha: 1 };
  const base = opaque ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 };
  const square = await sharp({ create: { width: 56, height: 56, channels: 4, background: mark } }).png().toBuffer();
  // Inset 4px so an opaque picture's top-left pixel (its backdrop) is the background, not a mark.
  const corners = [[4, 4], [S - 60, 4], [4, S - 60], [S - 60, S - 60]].map(([left, top]) => ({ input: square, left, top }));
  const input = await sharp({ create: { width: S, height: S, channels: 4, background: base } }).composite(corners).png().toBuffer();
  const out = await onSquare(input, S, padding);
  const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const backdrop = [data[0], data[1], data[2]];
  const r = 0.4 * S;
  let outside = 0;
  let marksInside = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const isBackdrop = Math.abs(data[i] - backdrop[0]) + Math.abs(data[i + 1] - backdrop[1]) + Math.abs(data[i + 2] - backdrop[2]) < 12;
      const inCircle = (x + 0.5 - S / 2) ** 2 + (y + 0.5 - S / 2) ** 2 <= r * r;
      if (!isBackdrop && !inCircle) outside++;
      if (inCircle && data[i] > 180 && data[i + 1] < 90) marksInside++;
    }
  }
  return { outside, marksInside };
}

test("an uploaded icon's maskable form survives the launcher's circle — corners included (review of #1221)", async () => {
  // A square fits a radius-0.4 circle only with ≥ ~21.8% margin each side.
  assert.ok(MASKABLE_ICON_PADDING >= 0.5 - 0.4 / Math.SQRT2, "the whole picture fits inside the safe circle");
  for (const opaque of [true, false]) {
    const kept = await maskTest(MASKABLE_ICON_PADDING, opaque);
    assert.equal(kept.outside, 0, `${opaque ? "opaque" : "transparent"} picture: nothing but backdrop outside the circle`);
    assert.ok(kept.marksInside > 4 * 400, "all four corner marks are drawn inside it");
  }
  // The test can see clipping: the old 10% margin puts the corner marks outside the circle.
  assert.ok((await maskTest(0.1, true)).outside > 0, "10% would have cut the corners");
  // Logos in their maskable form use 24%: inside too.
  assert.equal((await maskTest(logoPadding(true), false)).outside, 0);
  const route = code("src/app/api/brand/icon/[tenantId]/route.ts");
  assert.match(route, /maskable \? await onSquare\(bytes, size, MASKABLE_ICON_PADDING\) : await sharp\(bytes\)/);
});

test("only a square icon is accepted — a wide picture would be cropped without warning (review of #1221)", () => {
  const action = code("src/app/actions/workspaceIcon.ts");
  assert.match(action, /if \(meta\.width !== meta\.height\) throw new ActionRefusal\(`The icon must be square/);
  assert.match(action, /if \(meta\.width < 192\) throw new ActionRefusal/);
});
