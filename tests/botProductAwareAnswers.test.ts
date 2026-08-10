import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderBotProductFacts } from "../src/lib/botProductFacts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("product facts expose only maintained CRM fields", () => {
  const rendered = renderBotProductFacts([{
    name: "Rover XL",
    model: "Rover XL",
    description: "Four-seat lifted lifestyle vehicle",
    basePriceCents: 23500000,
    seats: 4,
    rangeKm: 64,
    topSpeedKmh: 40,
    brochureUrl: "https://example.test/rover.pdf",
    colors: [{ name: "Black" }, { name: "White" }],
  }]);
  assert.match(rendered, /Rover XL/);
  assert.match(rendered, /Seats: 4/);
  assert.match(rendered, /Range: 64 km/);
  assert.match(rendered, /Top speed: 40 km\/h/);
  assert.match(rendered, /Colours: Black, White/);
  assert.match(rendered, /Brochure: https:\/\/example\.test\/rover\.pdf/);
  assert.doesNotMatch(rendered, /stock|finance|warranty|road/i);
});

test("missing product fields are omitted instead of guessed", () => {
  const rendered = renderBotProductFacts([{ name: "Scout 2", colors: [] }]);
  assert.equal(rendered, "[Scout 2]");
  assert.doesNotMatch(rendered, /Seats:|Range:|Top speed:|Price:|Brochure:/);
});

test("product context is capped before reaching the model", () => {
  const rendered = renderBotProductFacts(
    Array.from({ length: 30 }, (_, index) => ({ name: `Model ${index}`, description: "x".repeat(600) })),
    1200,
  );
  assert.ok(rendered.length <= 1200);
});

test("assistant receives maintained product facts and explicit no-inference fences", () => {
  const code = src("src/lib/botAi.ts");
  assert.match(code, /renderBotProductFacts\(products\)/);
  assert.match(code, /LIVE PRODUCT FACTS FROM THE CRM/);
  assert.match(code, /STOCK AVAILABILITY is NOT supplied/);
  assert.match(code, /FINANCE TERMS, ROAD-LEGAL\/REGISTRATION STATUS, WARRANTY DETAILS, ACCESSORY COMPATIBILITY and SERVICE POLICY must come from Approved Knowledge/);
  assert.match(code, /Product comparisons may use only fields explicitly supplied for both products/);
});

test("brochure links may be shared only when present in the product record", () => {
  const renderer = src("src/lib/botProductFacts.ts");
  assert.match(renderer, /product\.brochureUrl \? `Brochure:/);
  const ai = src("src/lib/botAi.ts");
  assert.match(ai, /A Brochure URL may be shared when it is supplied for that product/);
});
