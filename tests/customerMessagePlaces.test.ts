import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { kindsAt, MESSAGE_PLACES, messageEditorHref, messagePlace } from "../src/lib/customerMessagePlaces";
import { SIGNING_EMAILS, SIGNING_EMAIL_KINDS } from "../src/lib/signing/emailTemplates";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("every customer message has exactly one home, chosen by what sends it", () => {
  const placed = [...kindsAt("documents"), ...kindsAt("automatic"), ...kindsAt("settings")];
  assert.deepEqual([...placed].sort(), [...SIGNING_EMAIL_KINDS].sort(), "none lost, none twice");
  for (const kind of kindsAt("documents")) assert.equal(SIGNING_EMAILS[kind].group, "Signing & quotes", kind);
  for (const kind of kindsAt("automatic")) assert.ok(["Service & aftersales", "Reviews & surveys"].includes(SIGNING_EMAILS[kind].group), kind);
  for (const kind of kindsAt("settings")) assert.equal(SIGNING_EMAILS[kind].group, "Login & verification codes", kind);
  assert.ok(kindsAt("documents").includes("quote") && kindsAt("automatic").includes("service_reminder"));
});

test("the link to a message opens it where it lives", () => {
  assert.equal(messageEditorHref("quote"), "/document-studio?open=quote#template-quote");
  assert.equal(messageEditorHref("service_reminder"), "/journeys/messages?open=service_reminder#template-service_reminder");
  const code = kindsAt("settings")[0];
  assert.equal(messageEditorHref(code), `/settings?tab=email&open=${code}#template-${code}`);
  assert.equal(messagePlace("quote"), "documents");
});

test("each home renders its editors, owner-only like the actions behind them", () => {
  // Emails open in the document editor (EmailDesignCards); texts and WhatsApp stay text (CustomerMessageEditors).
  const studio = src("src/app/(app)/document-studio/page.tsx");
  assert.match(studio, /\{isOwner && \([\s\S]*?id="document-emails"[\s\S]*?<EmailDesignCards kinds=\{emailKindsAt\("documents"\)\} frame \/>[\s\S]*?<CustomerMessageEditors kinds=\{textKindsAt\("documents"\)\} open=\{open\} \/>/);
  const messages = src("src/app/(app)/journeys/messages/page.tsx");
  assert.match(messages, /await requireTenantOwner\(\);/);
  assert.match(messages, /<EmailDesignCards kinds=\{emailKindsAt\("automatic"\)\} frame \/>/);
  assert.match(messages, /<CustomerMessageEditors kinds=\{textKindsAt\("automatic"\)\} open=\{open\} \/>/);
  assert.match(messages, /SIGNING_EMAIL_KINDS\.map/, "the index lists every message");
  const settings = src("src/app/(app)/settings/page.tsx");
  assert.match(settings, /<EmailDesignCards kinds=\{emailKindsAt\("settings"\)\} \/>/);
  assert.match(settings, /<CustomerMessageEditors kinds=\{textKindsAt\("settings"\)\} open=\{openTemplate\} \/>/);
  assert.doesNotMatch(settings, /saveSigningEmailTemplate/, "the editor exists once, in CustomerMessageEditors");
  // Own templates: Marketing → Templates when the module is on; kept here only when it is off.
  assert.match(settings, /\{marketingOn \? \([\s\S]*?href="\/marketing\/templates"/);
  assert.match(src("src/app/(app)/journeys/page.tsx"), /\{isOwner && \(\s*<Link href="\/journeys\/messages"/);
});

test("saving or resetting a message refreshes every page that shows it", () => {
  const actions = src("src/app/actions/emails.ts");
  for (const fn of ["saveSigningEmailTemplate", "resetSigningEmailTemplate"]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`), actions.indexOf("\n}\n", actions.indexOf(`export async function ${fn}`)));
    assert.match(body, /revalidateMessagePlaces\(\);/, fn);
  }
  assert.match(actions, /for \(const \{ path \} of Object\.values\(MESSAGE_PLACES\)\) revalidatePath\(path\.split\("\?"\)\[0\]\);/);
  assert.deepEqual(Object.values(MESSAGE_PLACES).map((p) => p.path.split("?")[0]), ["/document-studio", "/journeys/messages", "/settings"]);
});

test("no link still points at the old Settings → Email editor", () => {
  const stale: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /tab=email&open=/.test(readFileSync(path, "utf8")) && !path.endsWith("customerMessagePlaces.ts")) stale.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  assert.deepEqual(stale, []);
});
