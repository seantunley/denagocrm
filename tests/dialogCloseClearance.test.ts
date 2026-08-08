import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string) {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

test("shared dialog headers reserve the close button clearance zone", () => {
  const dialog = source("src/components/ui/dialog.tsx");

  assert.match(
    dialog,
    /data-slot="dialog-header"[\s\S]*?className=\{cn\("[^"]*\bpr-12\b/,
  );
});

test("the inbox Archive action cannot occupy the dialog close button zone", () => {
  const inbox = source("src/components/SocialThreadList.tsx");
  const header = inbox.slice(
    inbox.indexOf('<div className="flex flex-wrap items-center gap-2 border-b'),
    inbox.indexOf('<div className="mt-4 max-h'),
  );

  assert.match(header, /\bpr-12\b/);
  assert.match(header, /"Archive"/);
});

test("custom modal headers also reserve close button clearance", () => {
  assert.match(source("src/components/Modal.tsx"), /<DialogHeader className="[^"]*\bpr-14\b/);
  assert.match(source("src/components/SettingsModal.tsx"), /overflow-y-auto[^"\n]*\bpr-14\b/);
});
