import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Messenger / Instagram replies while Meta refuses the CRM's (Sean, 2026-11-09: "I thought we fixed this").
 * The box gave way to nothing: staff typed replies Meta then refused as "app not approved".
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("refused is read from the workspace's latest finished Messenger/Instagram reply, not a setting", () => {
  const lib = read("src/lib/metaReplies.ts");
  assert.match(lib, /where: \{ tenantId, channel: \{ in: \["messenger", "instagram"\] \}, status: \{ in: \["sent", "dead"\] \} \}/);
  assert.match(lib, /orderBy: \{ updatedAt: "desc" \}/);
  assert.match(lib, /return latest\?\.status === "dead" && latest\.failureCode === "app_not_approved";/);
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

test("both inboxes pass whether Meta is refusing", () => {
  assert.match(read("src/app/(app)/inbox/page.tsx"), /metaRefused: await metaRepliesRefused\(\),/);
  const mobile = read("src/app/messages/page.tsx");
  assert.match(mobile, /const metaRefused = await metaRepliesRefused\(\);/);
  assert.equal((mobile.match(/metaRefused=\{metaRefused\}/g) ?? []).length, (mobile.match(/<SocialThreadList/g) ?? []).length);
  assert.match(read("src/components/SocialThreadList.tsx"), /metaRefused=\{metaRefused\} \/>/);
});
