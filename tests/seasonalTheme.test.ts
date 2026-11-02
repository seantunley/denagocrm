import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { HALLOWEEN_CSS, HALLOWEEN_TENANT_ID, halloweenOn } from "../src/lib/seasonalTheme";

const on = (at: string) => halloweenOn(HALLOWEEN_TENANT_ID, new Date(at));

test("Halloween is on for Denago from 25 October to midnight 31 October, Johannesburg time — every year", () => {
  for (const year of [2026, 2027, 2030]) {
    assert.equal(on(`${year}-10-24T23:59:59+02:00`), false, `${year}: not yet`);
    assert.equal(on(`${year}-10-25T00:00:00+02:00`), true, `${year}: starts`);
    assert.equal(on(`${year}-10-31T23:59:59+02:00`), true, `${year}: Halloween night`);
    assert.equal(on(`${year}-11-01T00:00:00+02:00`), false, `${year}: gone`);
  }
  // Johannesburg time, not the server's: 22:30 UTC on the 24th is already the 25th there.
  assert.equal(on("2027-10-24T22:30:00Z"), true);
  assert.equal(on("2027-10-31T22:30:00Z"), false);
  assert.equal(on("2027-12-25T10:00:00+02:00"), false);
  assert.equal(on("2027-06-15T10:00:00+02:00"), false);
});

test("only Denago's workspace — another business keeps its own look", () => {
  assert.equal(halloweenOn("cmuqzh9nw0002ia043i3a92o9", new Date("2027-10-30T12:00:00+02:00")), false);
  assert.equal(halloweenOn(null, new Date("2027-10-30T12:00:00+02:00")), false);
});

test("only the staff app, asked on every request, after the brand colour", () => {
  const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
  assert.match(layout, /\{style && <style>\{style\}<\/style>\}\s*\{\/\*[^*]*\*\/\}\s*\{halloweenOn\(activeTenantId\) && \(\s*<>\s*<style>\{HALLOWEEN_CSS\}<\/style>\s*<HalloweenDecor \/>\s*<\/>\s*\)\}/);
  // The decorations: under dialogs and the Ask bubble (z 50), still for reduced motion, never printed.
  assert.match(HALLOWEEN_CSS, /\.hw-decor \{[^}]*pointer-events: none;[^}]*z-index: 45;/);
  assert.match(HALLOWEEN_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(HALLOWEEN_CSS, /@media print \{ \.hw-decor \{ display: none; \} \}/);
  assert.match(readFileSync("src/components/HalloweenDecor.tsx", "utf8"), /aria-hidden="true"/);
  // The decoration never blocks a click and never prints.
  assert.match(HALLOWEEN_CSS, /pointer-events: none/);
  assert.match(HALLOWEEN_CSS, /@media print/);
});
