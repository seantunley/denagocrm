import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CODEX_DEFAULT_MODEL, CODEX_MODEL_FALLBACKS, currentSwitch, modelChoices } from "../src/lib/codexProtocol";

/**
 * Sean, 2026-11-02: "Why can't I change the model in settings for ChatGPT?" It was a free-text box labelled for
 * research only (it is DAX's model too), and a refused choice was swapped in silence. Now: a dropdown of the current
 * lineup, named for what it drives, and a visible line when ChatGPT refused the choice and DAX switched.
 */
const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the choices: the current lineup, recommended first and marked — and whatever is in use, even if unlisted", () => {
  const now = new Date("2026-11-02T10:00:00Z");
  const choices = modelChoices(CODEX_DEFAULT_MODEL, now);
  assert.deepEqual(choices.map((c) => c.id), [...new Set([CODEX_DEFAULT_MODEL, ...CODEX_MODEL_FALLBACKS])]);
  assert.equal(choices[0].label, `${CODEX_DEFAULT_MODEL} (recommended)`);
  assert.equal(choices.filter((c) => c.label.includes("recommended")).length, 1);
  // A model chosen before (or switched to) that isn't in the list is still shown — the page never misreports it.
  assert.ok(modelChoices("gpt-custom", now).some((c) => c.id === "gpt-custom"));
  // A retired one in use is shown as retired; retired ones are never OFFERED.
  assert.equal(modelChoices("gpt-5.5", now).find((c) => c.id === "gpt-5.5")?.label, "gpt-5.5 — retired");
  assert.ok(!modelChoices(CODEX_DEFAULT_MODEL, now).some((c) => c.id === "gpt-5.5"));
});

test("a swap is shown only while its replacement is still the model in use", () => {
  const raw = JSON.stringify({ from: "gpt-6-sol", to: "gpt-5.6-terra", at: "2026-11-02T09:00:00.000Z" });
  assert.deepEqual(currentSwitch(raw, "gpt-5.6-terra"), { from: "gpt-6-sol", to: "gpt-5.6-terra", at: "2026-11-02T09:00:00.000Z" });
  assert.equal(currentSwitch(raw, "gpt-6-astra"), undefined, "the owner chose another since: no notice");
  for (const bad of [null, "", "not json", JSON.stringify({ from: 1, to: "x", at: "y" })]) assert.equal(currentSwitch(bad, "x"), undefined);
});

test("wired: a dropdown named for DAX, the swap recorded and shown — no free-text model box", () => {
  const row = code("src/components/settings/WorkspaceIntegrationRows.tsx");
  assert.match(row, /title="ChatGPT subscription"/);
  assert.match(row, /<label className="label" htmlFor="codex-model">DAX and research model<\/label>/);
  assert.match(row, /<select id="codex-model" name="value" className="input font-mono" defaultValue=\{chatGpt\.model\}>/);
  assert.doesNotMatch(row, /<input name="value" className="input font-mono" defaultValue=\{chatGpt\.model\} \/>/);
  assert.match(row, /chatGpt\.state === "connected" && chatGpt\.switched &&/);
  const codex = code("src/lib/codex.ts");
  assert.match(codex, /await putSetting\(CODEX_MODEL_KEY, model\);\s*await putSetting\(CODEX_MODEL_SWITCH_KEY, JSON\.stringify\(\{ from: configured \?\? CODEX_DEFAULT_MODEL, to: model, at: new Date\(\)\.toISOString\(\) \}\)\);/);
  assert.match(codex, /const switched = currentSwitch\(await getSetting\(CODEX_MODEL_SWITCH_KEY\), model\);/);
});
