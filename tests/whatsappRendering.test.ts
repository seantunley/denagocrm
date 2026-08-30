import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  WA_BUTTON_MAX,
  WA_BUTTON_TITLE_MAX,
  WA_LIST_ROW_MAX,
  WA_LIST_TITLE_MAX,
  WA_LIST_DESCRIPTION_MAX,
  WA_BODY_MAX,
  WA_TEXT_MAX,
  renderWhatsAppChoice,
  renderWhatsAppText,
} from "../src/lib/whatsappRendering";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The builder's simulator drew every choice as a plain, untruncated list. On a
 * phone the same node is either three tappable buttons or a menu sheet, with
 * hard character limits — so a flow could read correctly in testing and arrive
 * cut mid-word, or with its fourth option hidden behind a "Choose" button the
 * author never saw.
 */

const opts = (n: number, label = (i: number) => `Option ${i + 1}`) =>
  Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: label(i) }));

test("THREE OR FEWER OPTIONS ARE BUTTONS; A FOURTH CHANGES THE INTERFACE", () => {
  // The whole reason the preview exists. Same authored node, different UI, and
  // a different title limit (20 vs 24) — invisible until it reaches a handset.
  assert.equal(renderWhatsAppChoice("Pick", opts(3)).shape, "buttons");
  assert.equal(renderWhatsAppChoice("Pick", opts(4)).shape, "list");
  assert.equal(WA_BUTTON_MAX, 3);
});

test("a button title is cut at twenty characters, and says so", () => {
  const long = "Book a service appointment today";
  const rendered = renderWhatsAppChoice("Pick", [{ id: "a", label: long }]);
  assert.equal(rendered.options[0].title.length, WA_BUTTON_TITLE_MAX);
  assert.equal(rendered.options[0].title, long.slice(0, 20));
  assert.equal(rendered.options[0].titleTruncated, true);
});

test("a list row gets four more characters than a button", () => {
  const long = "Book a service appointment today";
  const asList = renderWhatsAppChoice("Pick", [...opts(3), { id: "x", label: long }]);
  const row = asList.options.find((o) => o.id === "x");
  assert.equal(row?.title.length, WA_LIST_TITLE_MAX);
  assert.equal(WA_LIST_TITLE_MAX - WA_BUTTON_TITLE_MAX, 4, "the two limits genuinely differ");
});

test("OPTIONS PAST THE LIMIT ARE NOT SHOWN AT ALL — they are reported, not hidden", () => {
  // Silently dropping the eleventh option is how a flow loses a branch nobody
  // can reach. The renderer hands them back so the preview can say so.
  const rendered = renderWhatsAppChoice("Pick", opts(13));
  assert.equal(rendered.options.length, WA_LIST_ROW_MAX);
  assert.equal(rendered.dropped.length, 3);
  assert.deepEqual(rendered.dropped.map((o) => o.id), ["o10", "o11", "o12"]);
});

test("a description is shown on a list row and dropped from a button", () => {
  const withDesc = { id: "a", label: "Yes", description: "Confirm the booking" };
  assert.equal(renderWhatsAppChoice("Pick", [withDesc]).options[0].description, undefined);
  const list = renderWhatsAppChoice("Pick", [...opts(3), withDesc]);
  assert.equal(list.options.find((o) => o.id === "a")?.description, "Confirm the booking");
});

test("a long description is cut at seventy-two", () => {
  const long = "x".repeat(100);
  const list = renderWhatsAppChoice("Pick", [...opts(3), { id: "a", label: "Yes", description: long }]);
  const row = list.options.find((o) => o.id === "a");
  assert.equal(row?.description?.length, WA_LIST_DESCRIPTION_MAX);
  assert.equal(row?.descriptionTruncated, true);
});

test("an interactive body is cut at 1024 on both shapes", () => {
  const long = "y".repeat(2000);
  assert.equal(renderWhatsAppChoice(long, opts(2)).body.length, WA_BODY_MAX);
  assert.equal(renderWhatsAppChoice(long, opts(2)).bodyTruncated, true);
  assert.equal(renderWhatsAppText("short").truncated, false);
});

/*
 * A PLAIN TEXT MESSAGE IS NOT AN INTERACTIVE BODY. 1,024 is the interactive
 * limit; a text message gets 4,096. Applying the interactive number to text made
 * the preview stamp "cut by WhatsApp" on a message `sendWhatsAppText` forwards
 * untouched, and a preview that invents truncation is no more usable than one
 * that hides it — this component's whole claim is that its cuts are real.
 */
test("a plain text message is cut at 4096, not 1024", () => {
  const overInteractive = "y".repeat(2000);
  assert.equal(renderWhatsAppText(overInteractive).truncated, false, "2,000 characters arrive whole");
  assert.equal(renderWhatsAppText(overInteractive).text.length, 2000);

  const overText = "y".repeat(5000);
  assert.equal(renderWhatsAppText(overText).text.length, WA_TEXT_MAX);
  assert.equal(renderWhatsAppText(overText).truncated, true);
});

test("text that fits is reported as untouched", () => {
  const rendered = renderWhatsAppChoice("Pick one", opts(2));
  assert.equal(rendered.bodyTruncated, false);
  assert.ok(rendered.options.every((o) => !o.titleTruncated));
  assert.deepEqual(rendered.dropped, []);
});

/* ── the limits must be ONE set of numbers ───────────────────────────────── */

test("the live transport uses these constants, so the preview cannot lie", () => {
  /*
   * A preview that disagreed with the sender would be worse than none, because
   * it would be believed. The numbers were written out as bare `.slice(0, 20)`
   * calls inside whatsapp.ts; they are imported now.
   */
  const transport = src("src/lib/whatsapp.ts");
  assert.match(transport, /from "\.\/whatsappRendering"/);
  assert.match(transport, /text: \{ body: text\.slice\(0, WA_TEXT_MAX\) \}/);
  assert.match(transport, /buttons\.slice\(0, WA_BUTTON_MAX\)/);
  assert.match(transport, /title: b\.title\.slice\(0, WA_BUTTON_TITLE_MAX\)/);
  assert.match(transport, /rows\.slice\(0, WA_LIST_ROW_MAX\)/);
  assert.match(transport, /title: r\.title\.slice\(0, WA_LIST_TITLE_MAX\)/);
  // …and no hand-written copy of any of them is left behind.
  assert.doesNotMatch(transport, /slice\(0, 20\)|slice\(0, 24\)|slice\(0, 72\)|slice\(0, 1024\)/);
});

test("the buttons/list threshold matches the one the outbox actually applies", () => {
  // botOutbox.ts decides the shape when sending. If that rule and this one ever
  // disagree, the preview shows an interface the customer never gets.
  const outbox = src("src/lib/botOutbox.ts");
  assert.match(outbox, /message\.options\.length <= 3/);
  assert.equal(WA_BUTTON_MAX, 3, "renderWhatsAppChoice must switch at the same count");
});


test("the text preview names the same 4096-character limit the sender enforces", () => {
  const preview = src("src/components/WhatsAppPreview.tsx");
  assert.match(preview, /CutBadge what="message at 4096 characters"/);
  assert.doesNotMatch(preview, /CutBadge what="message at 1024 characters"/);
});

test("only the latest choice message remains actionable", () => {
  const preview = src("src/components/WhatsAppPreview.tsx");
  assert.match(preview, /const activeChoiceLineId = lines\.reduce<string \| null>/);
  assert.equal(
    (preview.match(/disabled=\{disabled \|\| entry\.id !== activeChoiceLineId\}/g) ?? []).length,
    2,
    "both reply buttons and list sheets must disable historical choices",
  );
});
