import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/*
 * sendWhatsAppMessage and the Messenger reply action REFUSE a message that
 * arrives without a composition id ("This reply is missing its send key") — it
 * is what stops a second press of Send delivering the message twice.
 *
 * The inbox's reply box has supplied one since that rule was made (2026-08-10).
 * The WhatsApp box on the lead and customer pages never did, so for two months
 * every send from it failed with that message (reported 2026-10-12). Nothing
 * checked that a box posting to these actions carries the key. This does.
 */

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx$/.test(name) ? [path] : [];
  });

test("every reply box that posts to an action requiring a send key posts one", () => {
  const actions = readFileSync("src/app/actions/whatsapp.ts", "utf8") + readFileSync("src/app/actions/messenger.ts", "utf8");
  assert.match(actions, /if \(!compositionId\) return \{ error: "This reply is missing its send key/, "the rule this guards is still the rule");

  // A component that hands one of those actions to a form (useActionState) must render the hidden field.
  const boxes = files("src").filter((file) => {
    const src = readFileSync(file, "utf8");
    return /from "@\/app\/actions\/(whatsapp|messenger)"/.test(src) && /useActionState/.test(src);
  });
  assert.ok(boxes.some((file) => file.replace(/\\/g, "/").endsWith("components/WhatsAppPanel.tsx")), "the lead/customer WhatsApp box is covered");
  assert.ok(boxes.some((file) => file.replace(/\\/g, "/").endsWith("components/InboxReply.tsx")), "the inbox reply box is covered");
  for (const file of boxes) {
    assert.match(readFileSync(file, "utf8"), /<input type="hidden" name="compositionId" value=\{compositionId\} \/>/, `${file} posts no send key`);
  }
});

test("the WhatsApp box: one key per composition — kept across a failed send, renewed only after a confirmed one", () => {
  const box = readFileSync("src/components/WhatsAppPanel.tsx", "utf8");
  // Made in the browser, not while rendering (the server's and the browser's would differ).
  assert.match(box, /const \[compositionId, setCompositionId\] = useState<string>\(""\);/);
  assert.match(box, /if \(!compositionId\) setCompositionId\(crypto\.randomUUID\(\)\);/);
  // Renewed on success only: a failed send keeps its key, so pressing Send again is the same message.
  assert.match(box, /if \(!state\?\.ok\) return;\s*formRef\.current\?\.reset\(\);\s*setCompositionId\(crypto\.randomUUID\(\)\);/);
  assert.equal((box.match(/setCompositionId\(/g) ?? []).length, 2);
  // Send is not offered before the key exists.
  assert.match(box, /disabled=\{pending \|\| !compositionId\}/);
});
