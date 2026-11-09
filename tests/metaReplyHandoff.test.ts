import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Messenger / Instagram replies while Meta refuses the CRM's (Sean, 2026-11-09: "I thought we fixed this").
 * The box gave way to nothing: staff typed replies Meta then refused as "app not approved".
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("refused is per channel, from Meta's own refusals — a delivered reply (maybe to a tester) never clears it", () => {
  const lib = read("src/lib/metaReplies.ts");
  assert.match(lib, /by: \["channel"\]/);
  assert.match(lib, /status: "dead", failureCode: "app_not_approved", updatedAt: \{ gte: since \}/);
  assert.match(lib, /return \{ messenger: channels\.has\("messenger"\), instagram: channels\.has\("instagram"\) \};/);
  // Review of #1042: the old "latest finished reply" rule let one tester's delivery bring the box back for everyone.
  assert.doesNotMatch(lib, /status: \{ in: \["sent", "dead"\] \}/);
  assert.doesNotMatch(lib, /orderBy: \{ updatedAt: "desc" \}/);
});

test("on Messenger and Instagram the box hands off to Meta Business Suite — WhatsApp only when there is a number", () => {
  const box = read("src/components/InboxReply.tsx");
  assert.match(box, /if \(metaChannel && metaRefused && !sendAnyway\) \{\s*return <MetaReplyHandoff/);
  assert.match(box, /const metaChannel = channel === "messenger" \|\| channel === "instagram";/);
  assert.match(box, /href=\{META_BUSINESS_INBOX\} target="_blank"/);
  assert.match(box, /const whatsappHref = phone \? \(leadId \? `\/leads\/\$\{leadId\}\?compose=whatsapp` : contactId \? `\/contacts\/\$\{contactId\}\?compose=whatsapp` : null\) : null;/);
  // Testers still get through Meta — so the CRM can still send to them, on purpose.
  assert.match(box, /Send from the CRM anyway \(reaches testers only\)/);
});

test("each thread reads ITS channel's answer, on both inboxes", () => {
  assert.match(read("src/app/(app)/inbox/page.tsx"), /metaRefused: await metaRepliesRefused\(\),/);
  const mobile = read("src/app/messages/page.tsx");
  assert.match(mobile, /const metaRefused = await metaRepliesRefused\(\);/);
  assert.equal((mobile.match(/metaRefused=\{metaRefused\}/g) ?? []).length, (mobile.match(/<SocialThreadList/g) ?? []).length);
  assert.match(read("src/components/SocialThreadList.tsx"), /metaRefused=\{\(thread\.channel === "messenger" \|\| thread\.channel === "instagram"\) && Boolean\(metaRefused\?\.\[thread\.channel\]\)\} \/>/);
});
