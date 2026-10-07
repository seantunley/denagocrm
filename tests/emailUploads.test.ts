import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { EMAIL_UPLOAD_MAX_BYTES, emailUploads } from "../src/lib/emailUploads";

/*
 * Sean, 2026-10-07: the email composer "must be able to upload an attachment as
 * well" as attach from the library. Files from the computer are checked before
 * anything is sent, attached, and named on the timeline and in the audit.
 */

const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: "application/pdf" });
const form = (...entries: unknown[]) => ({ getAll: (n: string) => (n === "upload" ? entries : []) });

test("files from the computer come through; the empty entry a blank file input posts does not", () => {
  const out = emailUploads(form(file("Brochure.pdf", 2_000), new File([], ""), "not-a-file"));
  assert.ok("files" in out);
  assert.deepEqual(out.files.map((f) => f.name), ["Brochure.pdf"]);
  assert.deepEqual(emailUploads(form()), { files: [] });
});

test("refused before sending: too many, too big in total, or a program", () => {
  assert.match(String((emailUploads(form(...Array.from({ length: 6 }, (_, i) => file(`f${i}.pdf`, 10)))) as { error: string }).error), /at most 5 files/);
  const big = emailUploads(form(file("a.pdf", EMAIL_UPLOAD_MAX_BYTES / 2 + 1), file("b.pdf", EMAIL_UPLOAD_MAX_BYTES / 2 + 1)));
  assert.match(String((big as { error: string }).error), /under 10 MB in total/);
  for (const name of ["setup.exe", "run.BAT", "macro.vbs", "x.js", "install.msi"]) {
    assert.match(String((emailUploads(form(file(name, 10))) as { error: string }).error), /programs and scripts are blocked/, name);
  }
  assert.ok("files" in emailUploads(form(file("Quote.docx", 10), file("photo.JPG", 10), file("sheet.xlsx", 10))));
});

test("the send action attaches them and names them like library files; the composer offers Upload a file", () => {
  const action = readFileSync(new URL("../src/app/actions/emails.ts", import.meta.url), "utf8");
  assert.match(action, /const uploads = emailUploads\(formData\);\s*if \("error" in uploads\) return \{ error: uploads\.error \};/);
  assert.match(action, /attachments\.push\(\{ filename: file\.name, content: Buffer\.from\(await file\.arrayBuffer\(\)\), contentType: file\.type \|\| undefined \}\);\s*attachedNames\.push\(file\.name\);/);
  // Checked and attached BEFORE the mail goes.
  assert.ok(action.indexOf("emailUploads(formData)") < action.indexOf("const result = await sendEmail({"));
  const composer = readFileSync(new URL("../src/components/EmailComposer.tsx", import.meta.url), "utf8");
  assert.match(composer, /⬆ Upload a file/);
  assert.match(composer, /type="file"\s+name="upload"\s+multiple/);
  assert.match(composer, /uploadRef\.current\.files = dt\.files;/, "the posted input always holds exactly the chips shown");
});
