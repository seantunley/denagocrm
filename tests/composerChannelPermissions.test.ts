import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { offeredModes } from "../src/components/CustomerComposer";

/*
 * Review of #894: the customer/deal composer offered every channel on ONE check, but each has its own permission —
 * email, internal notes and logged calls: contacts.edit or leads.edit (CUSTOMER_RECORD_WRITE_PERMISSIONS);
 * WhatsApp: inbox.reply. So someone with inbox.reply alone lost WhatsApp, someone without it saw a send the server
 * refuses, and on a customer's page a view-only member saw every channel.
 */
const read = (path: string) => readFileSync(path, "utf8");

test("only the channels the page passed are offered — `false` for one that is not theirs", () => {
  assert.deepEqual(offeredModes({ note: "n", whatsapp: "w", call: "c" }), ["note", "whatsapp", "call"]);
  assert.deepEqual(offeredModes({ note: false, whatsapp: "w", call: false }), ["whatsapp"], "inbox.reply alone: WhatsApp only");
  assert.deepEqual(offeredModes({ note: "n", whatsapp: false, call: "c" }), ["note", "call"], "a writer without inbox.reply: no WhatsApp");
  assert.deepEqual(offeredModes({ note: false, whatsapp: false, call: false }), []);
  // Nothing to offer at all: no composer box.
  assert.match(read("src/components/CustomerComposer.tsx"), /if \(!email && offered\.length === 0\) return null;/);
});

test("both pages pass each channel on the permission its server action requires", () => {
  for (const page of ["src/app/(app)/leads/[id]/page.tsx", "src/app/(app)/contacts/[id]/page.tsx"]) {
    const src = read(page);
    assert.match(src, /hasAnyPermission\(user, \.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\), hasPermission\(user, "inbox\.reply"\)/, page);
    assert.match(src, /email=\{canWriteRecord && <EmailComposer/, page);
    assert.match(src, /whatsapp=\{canReplyWhatsApp && <WhatsAppPanel/, page);
    assert.match(src, /note=\{canWriteRecord && <CustomerLogForm mode="note"/, page);
    assert.match(src, /call=\{canWriteRecord && <CustomerLogForm mode="call"/, page);
    // Reply / Forward only where the email composer they open is on the page.
    assert.match(src, /workspace=\{\{ context, replyable: canWriteRecord, composer:/, page);
  }
  assert.match(read("src/components/LeadTimeline.tsx"), /item\.email && workspace\.replyable && <EmailReplyButtons/);
});

test("…and those ARE the server actions' requirements", () => {
  const emails = read("src/app/actions/emails.ts");
  assert.match(emails.slice(emails.indexOf("export async function sendEmailAction")), /requireAnyPermission\(\.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\)/);
  const comms = read("src/app/actions/communications.ts");
  assert.match(comms.slice(comms.indexOf("export async function addCommunication")), /requireAnyPermission\(\.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\)/);
  const wa = read("src/app/actions/whatsapp.ts");
  assert.match(wa.slice(wa.indexOf("export async function sendWhatsAppMessage")), /requirePermission\("inbox\.reply"\)/);
});
