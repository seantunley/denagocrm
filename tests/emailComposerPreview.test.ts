import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Preview and Send build the email with the same function, so the preview is what goes out", () => {
  const actions = src("src/app/actions/emails.ts");
  const preview = actions.slice(actions.indexOf("export async function previewComposerEmail"), actions.indexOf("export async function sendEmailAction"));
  const send = actions.slice(actions.indexOf("export async function sendEmailAction"), actions.indexOf("export async function sendTestEmail"));
  assert.match(preview, /requireAnyPermission\(\.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\)/, "same gate as sending");
  assert.match(preview, /composerHtml\(user,/);
  assert.match(send, /const html = await composerHtml\(user, bodyHtml, profile\)/);
  assert.doesNotMatch(preview, /sendEmail\(/, "a preview never sends");
});

test("the preview renders in a sandboxed frame and offers Send from it", () => {
  const composer = src("src/components/EmailComposer.tsx");
  assert.match(composer, /sandbox=""\s+srcDoc=\{preview\.html\}/);
  assert.match(composer, /previewComposerEmail\(body\)/);
  // Any send outcome (sent, or an error to read on the form) closes the preview.
  assert.match(composer, /preview && preview\.sentState === state/);
});
