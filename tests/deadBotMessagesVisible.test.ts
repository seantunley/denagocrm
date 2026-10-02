import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #31: a bot (or staff) message that dead-letters parks the
// conversation at `delivery_failed` — the bot stops, the customer waits at a
// prompt they never got — and the only trace was the error log.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const outbox = src("src/lib/botOutbox.ts");

test("a dead message tells staff, without the customer's number", () => {
  // One notifier for both the worker's failure and the provider's late report.
  const push = outbox.slice(outbox.indexOf("async function notifyDeliveryFailed("), outbox.indexOf("async function failDelivery("));
  assert.match(push, /title: "A message didn't reach a customer",/);
  assert.match(push, /url: "\/inbox",/);
  assert.doesNotMatch(push, /\.key\b/, "the key is the phone number on WhatsApp");
  // Only after the kill committed — a lost race returns "retry" first.
  const fail = outbox.slice(outbox.indexOf("async function failDelivery("), outbox.indexOf("async function failDelivery(") + 2600);
  assert.ok(fail.indexOf("killMessageAndBacklog(") < fail.indexOf("await notifyDeliveryFailed("));
});

test("the parked sessions ARE the list, read through the guarded client", () => {
  const lib = src("src/lib/deadBotConversations.ts");
  assert.match(lib, /prisma\.botSession\.findMany\(\{\s*where: \{ ownership: "delivery_failed" \}/);
  // The same head the retry uses, so the reason shown and the message resent agree.
  assert.match(lib, /const head = await parkedFailureHead\(prisma, \{/);
  assert.match(lib, /sessionId: session\.id,/);
  assert.match(lib, /retryable: !PERMANENT_FAILURES\.has/);
  const page = src("src/app/(app)/inbox/page.tsx");
  assert.match(page, /Couldn&apos;t reach the customer/);
  assert.match(page, /count: handoffThreads\.length \+ deadConversations\.length/);
});

test("failures that did not park the conversation are listed and retried by message", () => {
  // Re-reviews of #733: (1) a staff reply leaves the session "human", which the
  // kill never parks; (2) a message the provider ACCEPTED and reported failed
  // later never went through the kill at all. Neither reached the list.
  const shared = outbox.slice(outbox.indexOf("export const UNPARKED_FAILURE = {"), outbox.indexOf("} satisfies Prisma.BotFlowOutboxWhereInput;"));
  assert.match(shared, /status: "dead",/);
  assert.match(shared, /NOT: \{ failureCode: "blocked_by_earlier_failure" \},/);
  assert.match(shared, /OR: \[\{ origin: "staff" \}, \{ providerMessageId: \{ not: null \} \}, \{ lastError: RETRY_SUPERSEDED \}\],/);

  const lib = src("src/lib/deadBotConversations.ts");
  const listed = lib.slice(lib.indexOf("const unparked = await"));
  assert.match(listed, /where: \{ \.\.\.UNPARKED_FAILURE, updatedAt: \{ gte:/);
  // Leaves the list once something reached the customer AFTER the failure was
  // known — an async report can land after later messages already went.
  assert.match(listed, /status: "sent", createdAt: \{ gt: failure\.updatedAt \}/);
  assert.match(listed, /if \(reachedSince\) continue;/);
  assert.match(listed, /failedMessageId: failure\.id,/);

  const retry = outbox.slice(outbox.indexOf("export async function requeueFailedMessage("), outbox.indexOf("async function drainConversation("));
  assert.match(retry, /return withStaffConversationScope\(async \(\) => \{/);
  // The same predicate as the list, so what is shown is what can be retried.
  assert.match(retry, /where: \{ id: outboxId, tenantId, \.\.\.UNPARKED_FAILURE \}/);
  // Human takeover (re-review of #733): a BOT message is not requeued once a
  // person owns the thread — the worker's fence would cancel it and the action
  // would claim "Sending again" over nothing. Checked under the fence's own lock,
  // before the claim, and refused with its own message.
  assert.match(retry, /if \(head\.origin === "bot" && !\(await botStillOwnsTx\(tx as unknown as TenantWriteTx, tenantId, head\.channel, head\.key\)\)\) \{\s*return \{ outcome: "human_owned" as const/);
  assert.ok(retry.indexOf('outcome: "human_owned"') < retry.indexOf("const claimed = await"));
  assert.match(src("src/app/actions/botDeliveries.ts"), /if \(outcome === "human_owned"\) refuse\(/);
  // …and the list does not offer it in that state.
  assert.match(listed, /retryable: !PERMANENT_FAILURES\.has\(failure\.failureCode \?\? ""\) && !\(failure\.origin === "bot" && \(await humanOwns\(failure\.channel, failure\.key\)\)\),/);
  assert.match(lib, /return session\?\.ownership === "human";/);
  // Claimed on the row itself; a second click finds it no longer dead.
  assert.match(retry, /updateMany\(\{ where: \{ id: head\.id, tenantId, status: "dead" \}, data: retryInFlight\(\) \}\);\s*if \(claimed\.count !== 1\) return \{ outcome: "not_parked" as const \};/);
  assert.match(retry, /lastError: \{ startsWith: blockedByPrefix\(head\.id\) \}/);
  // The conversation stays with the person who has it — never handed to the bot.
  assert.doesNotMatch(retry, /BotSession|ownership/);
  assert.ok(retry.indexOf('return { outcome: "permanent"') < retry.indexOf("const claimed = await"));

  const page = src("src/app/(app)/inbox/page.tsx");
  assert.match(page, /dead\.failedMessageId \? retryFailedMessage\.bind\(null, dead\.failedMessageId\) : retryDeadBotConversation\.bind\(null, dead\.channel, dead\.key\)/);
});

test("an async provider failure tells staff once, not on every redelivered webhook", () => {
  const ledger = outbox.slice(outbox.indexOf("async markFailed(failure) {"), outbox.indexOf("async park(failure) {"));
  // Only the sent → dead flip notifies, row by row and conditional on `sent`.
  assert.match(ledger, /status: "sent" \},\s*select: \{ id: true, origin: true \}/);
  assert.match(ledger, /updateMany\(\{ where: \{ id: row\.id, tenantId, status: "sent" \}, data \}\);\s*if \(flipped\.count === 1\) await notifyDeliveryFailed\(/);
  // The re-mark of an already-dead row stays, and stays quiet.
  const remark = ledger.slice(ledger.indexOf("const marked = await"));
  assert.doesNotMatch(remark, /notifyDeliveryFailed/);
  // Same push as the worker's failure, addressed to the conversation's tenant.
  const notify = outbox.slice(outbox.indexOf("async function notifyDeliveryFailed("), outbox.indexOf("async function failDelivery("));
  assert.match(notify, /"bot_handoff", \{ tenantId \}\)/);
  assert.match(outbox.slice(outbox.indexOf("async function failDelivery(")), /await notifyDeliveryFailed\(row, failureCode\);/);
});

test("retry claims the parked conversation atomically and resends only this failure", () => {
  const requeue = outbox.slice(outbox.indexOf("export async function requeueDeadConversation("));
  assert.match(requeue, /return withStaffConversationScope\(async \(\) => \{/);
  assert.match(requeue, /const head = await parkedFailureHead\(tx, \{ tenantId, channel, key, sessionId: session\.id \}\);/);
  assert.match(requeue, /if \(!head\) return \{ outcome: "not_parked" as const \};/);
  assert.match(requeue, /if \(head\.failureCode && PERMANENT_FAILURES\.has\(head\.failureCode\)\) return \{ outcome: "permanent" as const \};/);
  assert.match(requeue, /WHERE "tenantId" = \$1 AND "channel" = \$2 AND "key" = \$3 AND "ownership" = 'delivery_failed'/);
  assert.match(requeue, /if \(claimed !== 1\) return \{ outcome: "not_parked" as const \};/);
  // Permanent is refused BEFORE the claim, so a refused retry leaves it parked.
  assert.ok(requeue.indexOf('outcome: "permanent"') < requeue.indexOf("const claimed = await"));
  // The incident by identity, not by a time window (review of #733): the head
  // row itself (marked in flight), plus the rows whose blocked-by message names
  // that head's id — the same prefix the kill writes.
  const body = requeue.slice(0, requeue.indexOf("const RETRY_IN_FLIGHT"));
  assert.doesNotMatch(body, /getTime\(\)|updatedAt: \{ gte/);
  assert.match(body, /updateMany\(\{ where: \{ id: head\.id, tenantId, status: "dead" \}, data: retryInFlight\(\) \}\)/);
  assert.match(body, /failureCode: "blocked_by_earlier_failure",\s*lastError: \{ startsWith: blockedByPrefix\(head\.id\) \},\s*\},\s*data: BACKLOG_RESET\(\),/);
  assert.match(body, /return \{ outcome: "requeued" as const, headId: head\.id \};/);
  const kill = outbox.slice(outbox.indexOf("async function killMessageAndBacklog("), outbox.indexOf("async function failDelivery("));
  assert.match(kill, /const blocked = `\$\{blockedByPrefix\(row\.id\)\}\$\{lastError\}`\.slice\(0, 1000\);/);
  assert.match(outbox, /const blockedByPrefix = \(headId: string\) => `Blocked by earlier failed message \$\{headId\}: `;/);
  // Which failure parked the session is RECORDED at the kill, in the same
  // transaction, keyed by session id — not inferred from recency (re-review of
  // #733: a late provider receipt marks an older, sent message dead later).
  assert.match(kill, /UPDATE "BotSession"[\s\S]*?RETURNING "id"`/);
  assert.match(kill, /tenantId_channel_providerId: \{ tenantId, channel: `\$\{row\.channel\}\$\{PARKED_HEAD_SUFFIX\}`, providerId: session\.id \}/);
  assert.match(kill, /status: "completed",/, "written completed, so no inbound claim or parked-failure sweep picks it up");
  assert.match(kill, /update: \{ lastError: row\.id \},/);
  assert.match(outbox, /const PARKED_HEAD_SUFFIX = ":parked-head";/);
  assert.match(outbox, /const PARKED_FAILURE_SUFFIX = ":failed";/);
  const head = outbox.slice(outbox.indexOf("export async function parkedFailureHead("), outbox.indexOf("export async function requeueDeadConversation("));
  assert.match(head, /where: \{ tenantId, channel: `\$\{channel\}\$\{PARKED_HEAD_SUFFIX\}`, providerId: sessionId \}/);
  // Recorded → exactly that row; nothing else considered.
  assert.match(head, /if \(record\) \{\s*if \(!record\.lastError\) return null;\s*return db\.botFlowOutbox\.findFirst\(\{ where: \{ id: record\.lastError, tenantId, channel, key, status: "dead" \}, select \}\);\s*\}/);
  // Parked before the record existed → only rows the WORKER killed (never accepted,
  // so no provider id); an async receipt failure always has one.
  assert.match(head, /status: "dead", providerMessageId: null, NOT: \{ failureCode: "blocked_by_earlier_failure" \}/);
  const action = src("src/app/actions/botDeliveries.ts");
  // Staff-reply retry: same guard, same refusals as the parked-conversation one.
  const staffAction = action.slice(action.indexOf("export async function retryFailedMessage("));
  assert.match(staffAction, /const user = await requirePermission\("inbox\.reply"\);/);
  assert.match(staffAction, /if \(outcome === "permanent"\) refuse\(/);
  assert.match(staffAction, /if \(outcome === "not_parked" \|\| !channel \|\| !key \|\| !headId\) refuse\(/);
  assert.match(action, /const user = await requirePermission\("inbox\.reply"\);/);
  assert.match(action, /if \(outcome === "permanent"\) refuse\(/);
  assert.match(action, /if \(outcome === "not_parked" \|\| !headId\) refuse\(/);
});

test("a takeover between the retry and the send keeps the incident, and the action says so", () => {
  // Re-review of #733: the retry's lock ends with its transaction; a person can
  // take over before the flush, the fence cancels the bot message, and the action
  // still said "Sending again" while the failure vanished from the list.
  assert.match(outbox, /const RETRY_IN_FLIGHT = "Retrying a failed message";/);
  assert.match(outbox, /export const RETRY_SUPERSEDED = "Not sent again: a person took this conversation over first";/);
  // In flight: marked, failure code and provider id kept (not in the reset).
  const inFlight = outbox.slice(outbox.indexOf("const retryInFlight = () =>"), outbox.indexOf("const BACKLOG_RESET"));
  assert.match(inFlight, /lastError: RETRY_IN_FLIGHT/);
  assert.doesNotMatch(inFlight, /failureCode|providerMessageId/);
  // The marker survives the claim and a transient retry, so the cron path is covered too.
  const claim = outbox.slice(outbox.indexOf("async function claimOldest("), outbox.indexOf("function retryAt("));
  assert.match(claim, /lastError: isRetryInFlight\(row\.lastError\) \? row\.lastError : null/);
  const fail = outbox.slice(outbox.indexOf("async function failDelivery("), outbox.indexOf("async function botMayStillSpeak("));
  assert.match(fail, /lastError: isRetryInFlight\(row\.lastError\) \? `\$\{RETRY_IN_FLIGHT\}: \$\{lastError\}`/);
  // The fence withdraws a retried failure back to dead — never to cancelled.
  const fence = outbox.slice(outbox.indexOf("async function botMayStillSpeak("), outbox.indexOf("async function deliverClaimed("));
  assert.match(fence, /data: isRetryInFlight\(row\.lastError\)\s*\? \{ status: "dead", leaseUntil: null, lastError: RETRY_SUPERSEDED \}/);
  // The action reports what happened after the flush, not the requeue.
  const action = src("src/app/actions/botDeliveries.ts");
  const report = action.slice(action.indexOf("async function sendAndReport("), action.indexOf("export async function retryDeadBotConversation("));
  assert.ok(report.indexOf("await flushBotOutboxConversation(") < report.indexOf("await retriedMessageOutcome(headId)"));
  assert.match(report, /if \(result === "superseded"\) refuse\(/);
  assert.match(report, /if \(result === "failed"\) refuse\(/);
  assert.doesNotMatch(action, /success: "Sending again"/);
  for (const fn of ["retryDeadBotConversation", "retryFailedMessage"]) {
    const body = action.slice(action.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, 1400), /return sendAndReport\(channel, key, headId\);/, `${fn} reports the real outcome`);
  }
  const outcome = outbox.slice(outbox.indexOf("export async function retriedMessageOutcome("));
  assert.match(outcome, /if \(row\.status === "dead"\) return row\.lastError === RETRY_SUPERSEDED \? "superseded" : "failed";/);
});
