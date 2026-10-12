import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/app/(app)/assistant/page.tsx", import.meta.url), "utf8");

test("the Ask page uses the full width — no centred column with empty gutters", () => {
  // It was `mx-auto max-w-3xl`: a 768px strip in the middle of a wide screen,
  // with the scheduled questions and watches below a long conversation.
  assert.doesNotMatch(page, /mx-auto/);
  assert.doesNotMatch(page, /<div className="[^"]*\bmax-w-(xl|2xl|3xl|4xl|5xl|6xl|7xl|screen-[a-z0-9]+)\b/);
  // The conversation takes the room; what you manage sits beside it on a wide screen and stacks under it on a narrow one.
  // From 2xl (1536px), not xl: with the app's sidebar a side column at 1280px or 1440px left the
  // conversation NARROWER than the 768px it replaced (528px and 688px). Below 2xl it keeps the whole width.
  assert.match(page, /<div className="grid items-start gap-6 2xl:grid-cols-\[minmax\(0,1fr\)_minmax\(22rem,28rem\)\]">/);
  assert.doesNotMatch(page, /\b(lg|xl):grid-cols-\[minmax\(0,1fr\)/);
  const aside = page.slice(page.indexOf("<aside"), page.indexOf("</aside>"));
  for (const part of ["⏰ Scheduled", "👀 Watching", "<AssistantWhatsAppCard", "About you"]) assert.ok(aside.includes(part), `${part} is in the side column`);
  assert.ok(page.indexOf("<AssistantChat") < page.indexOf("<aside"), "the conversation comes first, on every screen");
});
