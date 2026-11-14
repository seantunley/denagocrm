import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { logoIsLight } from "../src/lib/logoTone";

/** A 300×100 logo: a filled bar of `colour` across the middle, on transparency or on a solid background. */
const logo = (colour: { r: number; g: number; b: number }, background: { r: number; g: number; b: number; alpha: number }) =>
  sharp({ create: { width: 300, height: 100, channels: 4, background } })
    .composite([{ input: { create: { width: 260, height: 40, channels: 4, background: { ...colour, alpha: 1 } } }, top: 30, left: 20 }])
    .png()
    .toBuffer();
const clear = { r: 0, g: 0, b: 0, alpha: 0 };

test("white lettering on transparency (Denago Cape Town's logo) goes on a dark panel", async () => {
  assert.equal(await logoIsLight(await logo({ r: 255, g: 255, b: 255 }, clear)), true);
  assert.equal(await logoIsLight(await logo({ r: 235, g: 235, b: 240 }, clear)), true, "near-white counts");
});

test("a dark or coloured logo is drawn as it is", async () => {
  assert.equal(await logoIsLight(await logo({ r: 20, g: 30, b: 60 }, clear)), false, "dark lettering");
  assert.equal(await logoIsLight(await logo({ r: 240, g: 100, b: 30 }, clear)), false, "orange");
});

test("a logo with its own solid background carries its own contrast", async () => {
  assert.equal(await logoIsLight(await logo({ r: 20, g: 30, b: 60 }, { r: 255, g: 255, b: 255, alpha: 1 })), false, "dark on white");
  assert.equal(await logoIsLight(await logo({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255, alpha: 1 })), false, "all white, no transparency");
});

test("the report puts a light logo on the dark panel, and a failed check draws it as it is", () => {
  const doc = readFileSync(new URL("../src/lib/pdf/AssistantReportDoc.tsx", import.meta.url), "utf8");
  assert.match(doc, /meta\.logo && meta\.logoOnDark \? \(\s*<View style=\{s\.logoPanel\}>/);
  assert.match(doc, /logoPanel: \{ backgroundColor: ink,/);
  const pdf = readFileSync(new URL("../src/lib/assistantReportPdf.tsx", import.meta.url), "utf8");
  assert.match(pdf, /logoOnDark: logo \? await logoIsLight\(logo\)\.catch\(\(\) => false\) : false,/);
});
