import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A document that asks for a one-time code must not leave the server before the
 * code is entered.
 *
 * It did. The check was a component wrapped around the finished document that
 * chose not to show it, so the customer saw a code prompt while the response
 * carried every sheet: the link alone was enough to read the document, and the
 * quote was marked "opened" by whoever held it.
 *
 * What the server actually sends is proven against a production build in
 * scripts/test-enforced-render.ts. These pin the shape that produces it, in the
 * unit run, where a change is caught in seconds rather than after a build.
 */
const page = readFileSync("src/app/signing/[token]/page.tsx", "utf8");
const gate = readFileSync("src/app/signing/[token]/IdentityGate.tsx", "utf8");

test("an unverified signer is answered before the document is rendered or marked as opened", () => {
  const render = page.slice(page.indexOf("async function renderSigningPage"));
  const refusal = render.search(/if \(gate\.required && !gate\.verified\) \{\s*return \(/);
  assert.ok(refusal > 0, "the page must return the code prompt, and nothing else, to a signer who has not been checked");

  for (const call of ["recordView(", "renderRequestSigningSheets(", "signedFieldStamps("]) {
    assert.ok(
      render.indexOf(call) > refusal,
      `${call}…) runs before the identity check is answered — the document is rendered, or marked opened, for someone who has not entered the code`,
    );
  }
});

test("the gate cannot be handed the document", () => {
  // No children: a gate that receives the document has already had it sent to
  // the browser, whatever it then decides to draw.
  assert.doesNotMatch(gate, /\bchildren\s*[,:}]|ReactNode/, "IdentityGate must not accept children — the document would ride along in the response");
  assert.doesNotMatch(page, /<\/IdentityGate>/, "the page must render the gate INSTEAD of the document, never around it");
  assert.match(gate, /router\.refresh\(\)/, "passing the check must ask the server for the page again — that is when the document is first sent");
});
