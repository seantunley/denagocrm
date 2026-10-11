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
  // `messageHtml` is the message plus, when files go as secure links, the block that lists them. Send passes
  // who it is going to (the signature banner depends on it); Preview passes the same, plus "this is a preview".
  assert.match(send, /await composerHtml\(user, messageHtml, profile, \{ to, contactId, leadId, choice \}\)/);
  assert.match(preview, /await composerHtml\(user, String\(bodyHtml \?\? ""\)\.trim\(\) \+ block, await getCompanyProfile\(\), \{ to, contactId, leadId, choice \}, true\)/);
  assert.doesNotMatch(preview, /sendEmail\(/, "a preview never sends");
});

test("the preview renders in a sandboxed frame and offers Send from it", () => {
  const composer = src("src/components/EmailComposer.tsx");
  assert.match(composer, /sandbox=""\s+srcDoc=\{preview\.html\}/);
  assert.match(composer, /previewComposerEmail\(\s*body,\s*\{ to: field\("to"\), contactId, leadId, choice: field\("banner"\) \},\s*secure && allFiles\.length > 0 \? \{ files: allFiles, days \} : undefined,\s*\)/);
  // Any send outcome (sent, or an error to read on the form) closes the preview.
  assert.match(composer, /preview && preview\.sentState === state/);
});
