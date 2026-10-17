import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
const drafts = src("src/lib/emailDrafts.ts");
const send = src("src/lib/composerSend.ts");
const actions = src("src/app/actions/emails.ts");
const fn = (code: string, name: string) => {
  const start = code.indexOf(`function ${name}`);
  assert.ok(start > 0, `${name} exists`);
  const next = code.indexOf("\nexport ", start + 1);
  const nextLocal = code.indexOf("\nasync function ", start + 1);
  const ends = [next, nextLocal].filter((i) => i > 0);
  return code.slice(start, ends.length ? Math.min(...ends) : undefined);
};

test("the send takes the person as an argument, so it lives outside any \"use server\" file", () => {
  // The directive, if there were one, is the file's first line.
  assert.match(send, /^import "server-only";/);
  assert.match(drafts, /^import "server-only";/);
  assert.match(send, /export async function sendComposerForm\(\s*user: PermissionUser,\s*formData: FormData,/);
  // The action is the only way in from a browser, and it takes the person from the session.
  const action = fn(actions, "sendEmailAction");
  assert.match(action, /const user = await requireAnyPermission\(\.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\);/);
  // The cron's flag is never taken from a browser.
  assert.match(action, /formData\.delete\("scheduledSend"\);/);
  assert.doesNotMatch(actions, /export async function sendComposerForm|export async function sendScheduled/);
});

test("checking only stops before anything is stored, rendered or sent", () => {
  const body = send.split("export async function sendComposerForm")[1];
  const stop = body.indexOf("if (options.check) return { warning, filing: { contactId, leadId } };");
  assert.ok(stop > 0);
  for (const effect of ["await saveFile(", "createSecureLinks(", "await sendEmail(", "prisma.communication.create("]) {
    assert.ok(stop < body.indexOf(effect), `${effect} comes after the check stops`);
  }
  // A quote's PDF is made when the email goes, from the quote as it is then.
  assert.ok(body.indexOf("if (options.check) continue;\n    const pdf = await quotePdf(quote.id);") > 0);
  // …and the warning is asked BEFORE the check stops, so a scheduled send is refused or confirmed now.
  assert.ok(body.indexOf("if (warning && !confirmed)") < stop);
});

test("a scheduled send is claimed in one statement before anything else, and never sent twice or retried", () => {
  const one = fn(drafts, "sendScheduled");
  const claim = one.indexOf('updateMany({ where: { id, tenantId, status: "scheduled", sendAt: { lte: new Date() } }, data: { status: "sending" } })');
  assert.ok(claim > 0, "claimed scheduled → sending");
  assert.match(one, /if \(claimed\.count !== 1\) return "skipped";/);
  assert.ok(claim < one.indexOf("sendComposerForm("), "claimed before it is sent");
  // Who it goes as is checked NOW, as a sign-in would be; gone → not sent, and said.
  assert.match(one, /user = await scheduledSenderFor\(row\.userId\);/);
  assert.match(one, /if \(!user\) return fail\("Not sent: the person who scheduled it can no longer send emails from this CRM\."\);/);
  // Permissions that cannot be READ put it back for the next run, rather than failing it.
  assert.match(one, /data: \{ status: "scheduled" \} \}\);\s*return "skipped";/);
  // An exception part-way never claims it did not go.
  assert.match(one, /It may not have gone — check the timeline before sending it again\./);
  // The ONE way back from "sending" to "scheduled" is that put-back — and it is before any attempt to send.
  const back = /status: "sending" \}, data: \{ status: "scheduled"/g;
  assert.equal(drafts.match(back)?.length, 1);
  assert.ok(one.search(back) < one.indexOf("sendComposerForm("));
  const sender = fn(drafts, "scheduledSenderFor");
  assert.match(sender, /if \(scope\?\.system\) return null;/);
  assert.match(sender, /resolveTenantMemberUser\(userId\)/);
  assert.match(sender, /hasAnyPermission\(user, \.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\)/);
});

test("the cron sends each due email bound to its own workspace", () => {
  const due = fn(drafts, "sendDueScheduledEmails");
  assert.match(due, /runInTenantScope\(\{ tenantId: row\.tenantId, system: false \}, \(\) => sendScheduled\(row\.id, row\.tenantId\)\)/);
  const route = src("src/app/api/cron/scheduled-emails/route.ts");
  assert.match(route, /if \(!isAuthorizedCron\(req\)\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);/);
  assert.match(route, /runCronPerTenant\(/);
});

test("a draft is its author's alone; every scheduled send on a record is shown to everyone who can open it", () => {
  assert.match(fn(drafts, "saveDraft"), /updateMany\(\{ where: \{ id, tenantId, userId: user\.id, status: "draft" \}, data: fields \}\)/);
  assert.match(fn(drafts, "finishDraft"), /deleteMany\(\{ where: \{ id, tenantId, userId: user\.id, status: "draft" \} \}\)/);
  const list = fn(drafts, "draftsOnRecord");
  assert.match(list, /OR: \[\{ status: "draft", userId: user\.id \}, \{ status: \{ in: \["scheduled", "sending", "failed"\] \} \}\]/);
  assert.match(list, /if \(!\(await mayUseRecord\(user, contactId, leadId\)\)\) return \[\];/);
  // Cancel: the author, or the owner — and the record's access either way.
  const cancel = fn(drafts, "cancelScheduled");
  assert.match(cancel, /if \(row\.userId !== user\.id && user\.role !== "owner"\)/);
  assert.match(cancel, /mayUseRecord\(user, row\.contactId, row\.leadId\)/);
  assert.match(cancel, /logAudit\(\{ action: "email\.schedule_cancelled"/);
});

test("files from the computer wait privately for a scheduled send, and are deleted once it has gone or is cancelled", () => {
  const schedule = fn(drafts, "scheduleComposerEmail");
  assert.match(schedule, /if \(uploads\.files\.length > 0 && !storesPrivately\(\)\)/);
  assert.match(schedule, /saveFile\(buffer, file\.name, type, tenantId\)/);
  assert.match(schedule, /logAudit\(\{\s*action: "email\.scheduled"/);
  assert.match(fn(drafts, "sendScheduled"), /await dropStoredFiles\(row\.files\);/);
  assert.match(fn(drafts, "cancelScheduled"), /await dropStoredFiles\(row\.files\);/);
  assert.match(fn(drafts, "openDraft"), /dropped = await dropStoredFiles\(row\.files\);/);
});

test("the table is isolated per workspace, additively", () => {
  const sql = src("prisma/migrations/20261015120000_email_drafts/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "EmailDraft"/);
  assert.match(sql, /ALTER TABLE "EmailDraft" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "EmailDraft" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /CREATE POLICY "EmailDraft_tenant_isolation" ON "EmailDraft"/);
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bALTER COLUMN\b|\bDELETE FROM\b/);
});

test("the composer keeps a draft as it is written, ends it on send, and offers Later", () => {
  const composer = src("src/components/EmailComposer.tsx");
  assert.match(composer, /saveTimer\.current = setTimeout\(\(\) => \{ saveTimer\.current = null; void saveDraftNow\(\); \}, 1500\);/);
  // Closing keeps it — a save still waiting is made before the window goes away.
  assert.match(composer, /function closeComposer\(\) \{\s*if \(sending\.current\) return;\s*if \(saveTimer\.current\) \{ cancelSave\(\); void saveDraftNow\(\); \}/);
  // Sending or scheduling cancels a waiting save, so no draft of a sent email is made — before anything is posted.
  const submit = composer.slice(composer.indexOf("async function submit("), composer.indexOf("const [preview, setPreview]"));
  assert.ok(submit.indexOf("cancelSave();") > 0 && submit.indexOf("cancelSave();") < submit.indexOf("sendEmailAction("));
  assert.match(composer, /<input type="hidden" name="draftId" value=\{draftId \?\? ""\} \/>/);
  // The time goes into what is POSTED, set in code at the moment of sending (#893 builds the FormData itself) —
  // never written into a field, which React reset on its next render, and "Schedule send" sent the email at once
  // (found testing it). Send now (no time) removes any.
  assert.match(submit, /if \(sendAt\) data\.set\("sendAt", sendAt\.toISOString\(\)\); else data\.delete\("sendAt"\);/);
  assert.doesNotMatch(composer, /name="sendAt"/);
  assert.doesNotMatch(composer, /\.value = at\.toISOString\(\)/);
  assert.match(composer, /const at = nextHalfHour\(new Date\(laterAt\)\);[\s\S]{0,80}void submit\(false, at\);/);
  assert.match(composer, /<EmailWaitingList /);
});
