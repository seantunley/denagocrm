import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chat = readFileSync("src/components/AssistantChat.tsx", "utf8");

test("in the side panel and on a phone the message box has a row to itself", () => {
  // The side panel: always two rows.
  assert.match(chat, /compact \? "flex flex-wrap items-center gap-2 rounded-xl/);
  assert.match(chat, /\$\{compact \? "basis-full" : "basis-full sm:basis-0"\}/);
  // The Ask page: two rows on a phone, one from `sm` up.
  assert.match(chat, /"card flex flex-wrap items-center gap-2 p-2 sm:flex-nowrap"/);
  // Send sits at the end of the tools row.
  assert.match(chat, /btn-primary h-10 px-4 text-sm \$\{compact \? "ml-auto" : "ml-auto sm:ml-0"\}/);
  // The emoji picker opens from the left there, where its button now is, so it can't run off the panel.
  assert.match(chat, /\$\{compact \? "left-0" : "left-0 sm:left-auto sm:right-0"\}/);
});
