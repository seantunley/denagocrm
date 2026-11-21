import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { choiceId, runFlow, FOLLOWS_US, type FlowCtx, type OutMsg } from "../src/lib/flow";
import { routeKindAllowed, routeMatches, FLOW_ROUTE_KINDS } from "../src/lib/flowRouteRule";
import { flowTemplate } from "../src/lib/flowTemplates";
import { validateFlow, flowVariables } from "../src/lib/flowValidation";
import { RESERVED_NAMES } from "../src/lib/flowSharedValues";
import { commentFlowReplyKey } from "../src/lib/instagramComments";

/**
 * Instagram follow gate, part 3 (Sean, 2026-11-21: "If we trigger on a comment from Instagram to send a guide from the
 * library, would we be able to check if someone has subscribed as a verification gate?" — subscribed = follows us;
 * "I want the CRM to handle it… Make sure all the pieces are available"; own Meta app, no third parties).
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("a Comment keyword route: Instagram only, matched against the comment and nothing else", () => {
  assert.ok(FLOW_ROUTE_KINDS.includes("comment"));
  assert.equal(routeKindAllowed("comment", "instagram"), true);
  assert.equal(routeKindAllowed("comment", "whatsapp"), false);
  assert.equal(routeKindAllowed("keyword", "whatsapp"), true);
  const comment = { kind: "comment", pattern: "guide" };
  assert.equal(routeMatches(comment, { text: "", commentText: "GUIDE please 💛" }), true);
  assert.equal(routeMatches(comment, { text: "send the guide" }), false, "a DM is not a comment");
  // The comment entry carries no DM text, so a DM keyword route never starts from a comment.
  assert.equal(routeMatches({ kind: "keyword", pattern: "guide" }, { text: "", commentText: "guide" }), false);
  assert.match(code("src/app/actions/flow.ts"), /if \(!routeKindAllowed\(kind, channel\)\) return \{ error: "A comment keyword starts a flow on Instagram only\." \};/);
  assert.match(code("src/app/(app)/bot-builder/routes/page.tsx"), /\{channel === "instagram" && <option value="comment">Comment keyword \(on your posts\)<\/option>\}/);
});

test("{{follows_us}}: the engine asks Instagram each time a Condition reads it", () => {
  assert.equal(FOLLOWS_US, "follows_us");
  assert.ok(flowVariables({ start: "a", nodes: { a: { id: "a", type: "end" } } }).includes("follows_us"), "offered in the builder");
  assert.ok(RESERVED_NAMES.has("follows_us"), "a shared value can't take it");
  assert.match(code("src/lib/flow.ts"), /if \(node\.condition\.variable === FOLLOWS_US && ctx\.followsUs\) vars\[FOLLOWS_US\] = \(await ctx\.followsUs\(\)\) \? "yes" : "no";/);
  // Instagram conversations only.
  assert.match(code("src/lib/flowDm.ts"), /\.\.\.\(platform === "instagram" \? \{ followsUs: \(\) => instagramFollowsUs\(senderId\) \} : \{\}\),/);
});

test("the ready-made flow: reply → follower check → the guide; non-followers asked twice, then a polite stop", async () => {
  const template = flowTemplate("instagram_follow_guide");
  assert.equal(template.id, "instagram_follow_guide");
  // Blocked only until the guide is chosen.
  assert.deepEqual(validateFlow(template.definition, ["instagram"]).filter((i) => i.severity === "error").map((i) => i.code), ["document.missing"]);
  const flow = structuredClone(template.definition);
  for (const node of Object.values(flow.nodes)) if (node.type === "document") node.documentId = "guide1";
  assert.deepEqual(validateFlow(flow, ["instagram"]).filter((i) => i.severity === "error"), []);
  // Instagram takes files now: no "can't receive files" warning.
  assert.ok(!validateFlow(flow, ["instagram"]).some((i) => i.code === "channel.document_fallback"));

  let follows = false;
  let asked = 0;
  const ctx = {
    aiReply: async () => ({ reply: "", handoff: false }),
    dynamicAnswer: async () => "",
    createBooking: async () => ({ ok: true }),
    handoff: async () => {},
    followsUs: async () => { asked += 1; return follows; },
  } as unknown as FlowCtx;
  const kinds = (messages: OutMsg[]) => messages.map((m) => m.type);

  // Turn 1 (the private reply): just the invitation to answer — nothing checked yet.
  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "GUIDE" }, ctx);
  assert.deepEqual(kinds(first.messages), ["text"]);
  assert.equal(asked, 0, "no follow check before they have messaged (Instagram couldn't say)");

  // They answer, not following: asked to follow and tap Done.
  const second = await runFlow(flow, first.session!, { text: "hi" }, ctx);
  assert.equal(asked, 1);
  assert.deepEqual(kinds(second.messages), ["choice"]);

  // They follow and tap Done: the guide, then the thanks.
  follows = true;
  const third = await runFlow(flow, second.session!, { text: "", choiceId: choiceId("follow1", "done") }, ctx);
  assert.equal(asked, 2);
  assert.deepEqual(kinds(third.messages), ["document", "text"]);
  assert.equal(third.session, null);

  // Someone who never follows: two re-checks, then the polite stop — never the guide.
  follows = false;
  let run = await runFlow(flow, { nodeId: null, vars: {} }, { text: "GUIDE" }, ctx);
  run = await runFlow(flow, run.session!, { text: "ok" }, ctx);
  run = await runFlow(flow, run.session!, { text: "", choiceId: choiceId("follow1", "done") }, ctx);
  run = await runFlow(flow, run.session!, { text: "", choiceId: choiceId("follow2", "done") }, ctx);
  assert.deepEqual(kinds(run.messages), ["text"]);
  assert.match((run.messages[0] as { text: string }).text, /I still can't see it/);
  assert.equal(run.session, null);
});

test("a comment starts its flow only through a Comment route, with the ONE private reply reserved first", () => {
  const runner = code("src/lib/instagramCommentFlow.ts");
  assert.match(runner, /if \(!commenter \|\| isOwnPageComment\(comment, igAccountId\)\) return;/);
  assert.match(runner, /where: \{ tenantId, channel: "instagram", enabled: true, kind: "comment" \}/);
  assert.match(runner, /if \(!routes\.some\(\(route\) => routeMatches\(route, entry\)\)\) return;/);
  // Reserved with the inbox's own key, BEFORE the flow runs or anything is sent.
  const reserve = runner.indexOf("dedupeKey: replyKey");
  assert.ok(reserve > 0 && reserve < runner.indexOf("await advanceFlow(") && reserve < runner.indexOf("sendPrivateReplyToComment("));
  // Once per person per post: the reservation's unique key is the person on the post, so a repeated "GUIDE", a
  // redelivery or a race finds it taken. A staff member's own private reply to the comment comes first.
  assert.equal(commentFlowReplyKey("t1", "post9", "user7"), "igcommentflow:t1:post9:user7");
  assert.notEqual(commentFlowReplyKey("t1", "post9", "user7"), commentFlowReplyKey("t1", "post10", "user7"), "another post: another reply");
  assert.match(runner, /const replyKey = commentFlowReplyKey\(tenantId, comment\.postId, commenter\);/);
  assert.match(runner, /if \(await prisma\.communication\.findFirst\(\{ where: \{ tenantId, dedupeKey: privateReplyDedupeKey\(tenantId, comment\.commentId\) \}, select: \{ id: true \} \}\)\) return;/);
  assert.ok(runner.indexOf("privateReplyDedupeKey(tenantId, comment.commentId)") < runner.indexOf("const replyKey"));
  assert.match(runner, /if \(isDedupeKeyConflict\(error\)\) return;/);
  assert.match(runner, /conversationId: filed\.conversationId, inReplyTo: comment\.commentId, dedupeKey: replyKey/);
  // Refused: reservation released and logged without customer data. No answer: kept (it may have been delivered).
  assert.match(runner, /if \(!sent\.ok\) \{\s*await deleteCommunicationsAndReconcile\(\{ dedupeKey: replyKey \}\);/);
  assert.match(runner, /\} catch \{\s*\/\/ No answer from Meta[^\n]*\n\s*await prisma\.communication\.updateMany\(\{ where: \{ dedupeKey: replyKey \}, data: \{ body: text \} \}\);\s*return;/);
  // A comment always starts its flow afresh (never an answer to the last question); a person-owned chat is left alone.
  assert.match(code("src/lib/flowSession.ts"), /const restart = decision\.act === "restart" \|\| Boolean\(entryContext\?\.commentText\);/);
  // Wired after the comment is filed, and never failing the delivery.
  assert.match(code("src/app/api/webhooks/meta/route.ts"), /recordPostCommentSafely\(decision\.comment, \{ platform: "instagram", pageId: igAccountId \}\);[\s\S]*?await runInstagramCommentFlow\(igAccountId, decision\.comment\)\.catch\(/);
});

test("the guide on Instagram: the file itself, else a link that expires — never a permanent one", () => {
  const outbox = code("src/lib/botOutbox.ts");
  assert.match(outbox, /if \(row\.channel === "instagram"\) return sendInstagramDocument\(row, doc, message\);/);
  assert.match(outbox, /const INSTAGRAM_LINK_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(outbox, /const sent = await sendInstagramFile\(row\.key, url\);\s*if \(sent\.ok\) return sent;/);
  assert.match(outbox, /outboundMediaUrl\(doc\.storedName, doc\.mimeType, \{ ttlMs: INSTAGRAM_LINK_TTL_MS \}\)/);
  // Uploaded first with platform instagram, then sent by id; the token in a header.
  const messenger = code("src/lib/messenger.ts");
  assert.match(messenger, /JSON\.stringify\(\{ platform: "instagram", message: \{ attachment: \{ type: "file", payload: \{ url, is_reusable: true \} \} \} \}\)/);
  assert.match(messenger, /\{ attachment: \{ type: "file", payload: \{ attachment_id: attachmentId \} \} \}/);
  // The caption follows the file as its own text, as on Messenger.
  assert.match(code("src/lib/botOutboxWrite.ts"), /\(channel === "messenger" \|\| channel === "instagram"\) && message\.type === "document" && message\.caption/);
});

test("the follow check: Instagram's own answer, the token never in a URL, and any doubt is 'no'", () => {
  const follow = code("src/lib/instagramFollow.ts");
  assert.match(follow, /fetch\(`\$\{GRAPH\}\/\$\{igsid\}\?fields=is_user_follow_business`, \{\s*headers: \{ Authorization: `Bearer \$\{token\}` \},/);
  assert.match(follow, /return \(await res\.json\(\)\.catch\(\(\) => null\)\)\?\.is_user_follow_business === true;/);
  assert.match(follow, /if \(!\/\^\\d\{5,32\}\$\/\.test\(igsid\)\) return false;/);
  assert.doesNotMatch(follow, /access_token=/);
});
