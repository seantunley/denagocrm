import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Creating a quote landed you in one of TWO different UIs depending on which
 * button you pressed: the lead page sent you to the read-only record page,
 * while the quotes list and the lead's own "next step" prompt opened the draft
 * editor. Same intent, same lead, different experience.
 */
test("every route to a NEW quote opens the draft editor", () => {
  const code = src("src/app/actions/quotes.ts");
  const creators = ["createQuoteFromLead", "createQuoteForContact"];
  for (const name of creators) {
    const at = code.indexOf(`export async function ${name}(`);
    assert.ok(at > 0, `${name} must exist`);
    // Read to the end of the function (next top-level export).
    const nextAt = code.indexOf("\nexport ", at + 1);
    const body = code.slice(at, nextAt > 0 ? nextAt : undefined);
    assert.match(
      body,
      /\/quotes\?edit=/,
      `${name} must open the editor, not the read-only record page`,
    );
    assert.doesNotMatch(
      body,
      /["'`]\/quotes\/\$\{quote\.id\}/,
      `${name} must not send a NEW quote to the record page`,
    );
  }
});

test("the split entry point is gone, not merely bypassed", () => {
  const code = src("src/app/actions/quotes.ts");
  assert.ok(
    !code.includes("createQuoteFromLeadInEditor"),
    "the second lead-to-quote creator must be removed, or the split can come back",
  );
  // …and nothing may still import it.
  for (const file of ["src/components/proactive/NextStep.tsx", "src/app/(app)/leads/[id]/page.tsx"]) {
    assert.ok(
      !src(file).includes("createQuoteFromLeadInEditor"),
      `${file} still references the removed creator`,
    );
  }
});

test("the next-step prompt reports the real outcome, not an optimistic one", () => {
  // It used to toast "Creating a quote…" as a SUCCESS before the action ran, so
  // a failure still read as though the quote had been created.
  const code = src("src/components/proactive/NextStep.tsx");
  const at = code.indexOf("createQuoteFromLead(leadId)");
  assert.ok(at > 0, "the prompt must still create the quote");
  const around = code.slice(Math.max(0, at - 400), at + 400);
  assert.match(around, /result\?\.error/, "a refusal must be surfaced");
  assert.match(around, /router\.push\(result\.redirectTo\)/, "it must follow the returned editor link");
  assert.doesNotMatch(
    around,
    /toast\.success\([^)]*\);\s*\n\s*(await\s+)?createQuoteFromLead/,
    "success must not be announced before the action runs",
  );
});
