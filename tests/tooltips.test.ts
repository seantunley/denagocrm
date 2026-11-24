import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * Sean, 2026-11-24: "update all the tooltips" / "make sure tooltips are in the valid places". A button or link that
 * shows only an icon or a symbol (✕ ↑ ↓ + −) says nothing until you hover it — so it must carry a tooltip (`title`).
 * A screen-reader label (aria-label / sr-only text) alone helps nobody with a mouse.
 */
const files = execSync('git ls-files "src/**/*.tsx"').toString().trim().split("\n");

const ICON_ONLY = /<(button|Button|a|Link)\b((?:[^<>]|\{[^{}]*\})*)>\s*<([A-Z][A-Za-z0-9.]*)\b[^<>]*\/>\s*(?:<span className="sr-only">[^<]*<\/span>\s*)?<\/\1>/g;
const SYMBOL_ONLY = /<(button|Button|a|Link|SaveButton)\b((?:[^<>]|\{[^{}]*\})*)>\s*([✕×⋯…↑↓+−✓]{1,2})\s*<\/\1>/gu;
// A wrapped picture (a logo, a stats card) is not an icon button.
const NOT_AN_ICON = /^(BrandLogo|MetricCard)$/;

test("every icon-only or symbol-only button and link has a tooltip", () => {
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [ICON_ONLY, SYMBOL_ONLY]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const [, , attributes, inner] = match;
        if (/\btitle=|asChild/.test(attributes)) continue;
        if (pattern === ICON_ONLY && NOT_AN_ICON.test(inner)) continue;
        missing.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Add a title="…" saying what it does:\n${missing.join("\n")}`);
});

/*
 * Sean, 2026-11-24: "Greyed out buttons must show tooltips that explain why they are greyed out." A button greyed
 * out for a REASON (nothing changed yet, a field still empty, a limit reached, a role that can't) carries a `title`
 * naming it. Greyed only WHILE WORKING (pending, saving, busy…) needs none: the label already says "Saving…".
 */
const DISABLED = /<(button|Button|SaveButton)\b((?:[^<>]|\{(?:[^{}]|\{[^{}]*\})*\})*?)\bdisabled=\{((?:[^{}]|\{[^{}]*\})*)\}((?:[^<>]|\{(?:[^{}]|\{[^{}]*\})*\})*)>/g;
const WORKING = /^(!*\(?)?(pending|isPending|saving|busy|loading|working|submitting|sending|uploading|deleting|testing|checking|starting|stopping|refreshing|generating|publishing|creating|requesting|resetting|confirming|disabling|previewing|sharing|reqPending|verPending|voicePending|photoPending|removePending|profilePending|emailPending|grokPending|passkey\.busy|busy !== null|!!busy|state === "busy"|state\.step === "checking"|linkBusy === [a-z.]+|busy === "[a-z]+"|busy === [a-z.]+|!dims|!compositionId)\)?$/;
// Shared wrappers forward the caller's own `title`; the WhatsApp preview's buttons are greyed because it is a preview.
const PASS_THROUGH = new Set(["src/components/SaveForm.tsx", "src/components/SaveSubmitButton.tsx", "src/components/PasskeyLoginButton.tsx", "src/components/WhatsAppPreview.tsx"]);

test("a button greyed out for a reason says why on hover", () => {
  const missing: string[] = [];
  for (const file of files) {
    if (PASS_THROUGH.has(file)) continue;
    const source = readFileSync(file, "utf8");
    DISABLED.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DISABLED.exec(source))) {
      const [, , before, condition, after] = match;
      if (/\btitle=|disabledReason=/.test(before + after)) continue;
      if (condition.split("||").every((part) => WORKING.test(part.replace(/\s+/g, " ").trim()))) continue;
      missing.push(`${file}:${source.slice(0, match.index).split("\n").length}  disabled={${condition.trim()}}`);
    }
  }
  assert.deepEqual(missing, [], `Add a title saying why it's greyed out, e.g. title={!dirty ? "No changes to save" : undefined}:\n${missing.join("\n")}`);
});

test("greyed-out buttons still react to hover, so their tooltip can show", () => {
  assert.doesNotMatch(readFileSync("src/components/ui/button.tsx", "utf8"), /disabled:pointer-events-none/);
});

test("tooltips speak plainly — no internal or developer words", () => {
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<[a-z][a-z0-9]*\b[^<>]*?\btitle="([^"]+)"/g)) {
      if (/\b(node|tenant|AI proofread|synopsis|JSON|DAX)\b|\/ preview|At\/below/i.test(match[1])) {
        offenders.push(`${file}: "${match[1]}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
