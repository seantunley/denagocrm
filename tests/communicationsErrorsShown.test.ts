import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, the last module: logging a call/note, archiving an inbox thread
// and deleting a timeline entry threw (or silently returned) instead of saying why.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/communications.ts");
const fn = (name: string) => {
  const at = actions.indexOf(`export async function ${name}(`);
  const next = actions.indexOf("\nexport async function ", at + 10);
  return actions.slice(at, next === -1 ? undefined : next);
};

test("form-facing actions return refusals", () => {
  for (const name of ["addCommunication", "toggleCommunicationPin", "setThreadArchived", "deleteCommunication"]) {
    assert.match(fn(name), /return asActionResult\(async \(\) => \{/, name);
    assert.doesNotMatch(fn(name), /throw new Error\(/, name);
    assert.doesNotMatch(fn(name), /findUniqueOrThrow\(/, name);
  }
});

test("an empty note and an over-size image are refused, not silently dropped", () => {
  const add = fn("addCommunication");
  assert.match(add, /if \(!body && !hasFile\) refuse\("Write a note or attach an image\."\)/);
  assert.match(add, /size > 4 \* 1024 \* 1024\) refuse\("Images must be 4 MB or smaller\."\)/);
});

test("a non-image file is refused, not counted as an attachment and then dropped", () => {
  const add = fn("addCommunication");
  const reject = add.indexOf('refuse("Only images can be attached to a note.")');
  assert.ok(reject > 0, "a non-image upload must be refused on the server");
  assert.match(add.slice(add.lastIndexOf("\n", reject), reject), /chosen && !\(file as File\)\.type\.startsWith\("image\/"\)/);
  // Checked before anything is written, so a refused call leaves no row or blob.
  assert.ok(reject < add.indexOf("saveFile("), "the type check must come before the upload");
  assert.ok(reject < add.indexOf("prisma.communication.create"), "the type check must come before the row");
});

test("deleting a timeline entry requires its reason on the server, after authorising", () => {
  const del = fn("deleteCommunication");
  assert.match(del, /const reason = requiredReason\(formData, "deleting this entry"\);/);
  assert.ok(del.indexOf("assertCommunicationAccess(") < del.indexOf("requiredReason("), "authorise before refuse");
});

test("the background read-marker never throws at the person opening a thread", () => {
  assert.doesNotMatch(fn("markThreadRead"), /throw new Error\(/);
});

test("the forms show the messages", () => {
  assert.doesNotMatch(src("src/components/CommsTimeline.tsx"), /<form action=\{addCommunication\}/);
  assert.doesNotMatch(src("src/components/LeadTimeline.tsx"), /<form action=\{addCommunication\}/);
  assert.doesNotMatch(src("src/components/SocialThreadList.tsx"), /<form action=\{setThreadArchived/);
});
