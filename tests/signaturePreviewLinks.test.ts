import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A signature preview's links open a new tab (Sean, 2026-11-20: the Workspace design preview turned into a grey
 * "refused" page — a click on the logo had loaded the website inside the frame, and websites refuse to be framed).
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("both signature previews open links in a new tab, from a frame that allows it and still runs no scripts", () => {
  const visual = code("src/components/SignatureVisualEditor.tsx");
  assert.match(visual, /export const PREVIEW_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";/);
  assert.match(visual, /<base target="_blank">/);
  for (const file of ["src/components/SignatureVisualEditor.tsx", "src/components/SignatureDesignEditor.tsx"]) {
    const src = code(file);
    assert.match(src, /sandbox=\{PREVIEW_SANDBOX\}/, file);
    assert.match(src, /previewDocument\(/, file);
    assert.doesNotMatch(src, /sandbox="[^"]*allow-scripts/, file);
  }
});
