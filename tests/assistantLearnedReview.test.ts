import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REVIEW_IN_BRIEF,
  idsFor,
  learnedLine,
  parseReviewReply,
  readOffer,
  reviewOfferKey,
  reviewSection,
  type LearnedItem,
} from "../src/lib/assistantLearnedReviewRules";

// Sean, 2026-11-20: "We have a similar setup where it's learning, but I think ours gets buried somewhere." On production
// it had learned 3 times in ~190 questions, WhatsApp never said so, and the list sat folded at the bottom of Settings.

const item = (id: string, over: Partial<LearnedItem> = {}): LearnedItem => ({ id, kind: "memory", name: null, description: null, content: `fact ${id}`, ...over });

test("a reply to the brief's list is exactly that — anything else stays a question for DAX", () => {
  assert.deepEqual(parseReviewReply("keep 1"), { verdict: "keep", which: [1] });
  assert.deepEqual(parseReviewReply("Drop 2 and 3."), { verdict: "drop", which: [2, 3] });
  assert.deepEqual(parseReviewReply(" keep 1,3, 3 "), { verdict: "keep", which: [1, 3] });
  assert.deepEqual(parseReviewReply("KEEP ALL"), { verdict: "keep", which: "all" });
  for (const question of ["keep", "keep it", "keep 1 in mind for Anna", "should I keep 2 demos?", "drop 0", "drop the price for Anna", "keep 123"]) {
    assert.equal(parseReviewReply(question), null, question);
  }
});

test("numbers mean the list the owner read; one outside it is named back, never guessed; old lists don't count", () => {
  const now = new Date("2026-11-20T08:00:00Z");
  const offer = readOffer(JSON.stringify({ ids: ["a", "b", "c"], at: "2026-11-20T05:30:00Z" }), now)!;
  assert.deepEqual(idsFor({ verdict: "keep", which: [1, 3, 7] }, offer), { ids: ["a", "c"], unknown: [7] });
  assert.deepEqual(idsFor({ verdict: "drop", which: "all" }, offer), { ids: ["a", "b", "c"], unknown: [] });
  assert.equal(readOffer(JSON.stringify({ ids: ["a"], at: "2026-11-16T05:30:00Z" }), now), null, "four days old");
  for (const bad of [null, "", "x", JSON.stringify({ ids: [1], at: "2026-11-20T05:30:00Z" }), JSON.stringify({ ids: ["a"] })]) assert.equal(readOffer(bad, now), null);
  assert.equal(reviewOfferKey("u1"), "ASSISTANT_REVIEW_OFFER:u1");
});

test("the brief's section: numbered, what each says, how to answer — and nothing when nothing waits", () => {
  assert.equal(reviewSection([], 0), "");
  const text = reviewSection([item("a"), item("b", { kind: "playbook", name: "hot-lead", description: "a lead ready to buy" })], 7);
  assert.match(text, /🧠 To review — what DAX learned \(7\)/);
  assert.match(text, /\n1\. About the business: fact a\n2\. Playbook: “hot-lead” — a lead ready to buy\n/);
  assert.match(text, /…and 5 more in Settings → Assistant\./);
  assert.match(text, /reply “keep 1”, “drop 2”, “keep all” or “drop all”/);
  assert.ok(learnedLine(item("x", { content: "y".repeat(400) })).length < 200, "a long entry is cut to one line");
  assert.ok(REVIEW_IN_BRIEF <= 9, "single digits, so a reply is unambiguous");
});

test("wired: the owner's brief carries it, WhatsApp answers the reply first, the chat shows it, Settings puts it first", () => {
  const src = (f: string) => readFileSync(f, "utf8");
  const lib = src("src/lib/assistantLearnedReview.ts");
  // Owner only, the same rule as isTenantOwner; only unreviewed (a held conflict needs Settings' side-by-side).
  assert.match(lib, /if \(!\(await ownsWorkspace\(tenantId, user\)\)\) return "";/);
  assert.match(lib, /if \(!\(await ownsWorkspace\(tenantId, user\)\)\) return "Only the workspace owner/);
  assert.match(lib, /pg_advisory_xact_lock\(hashtext\(\$\{`assistant-notes:\$\{tenantId\}`\}\)::bigint\)/);
  assert.match(lib, /where: \{ tenantId, id: \{ in: ids \}, status: "unreviewed" \}/);
  assert.match(lib, /action: verdict === "keep" \? "assistant\.note_approved" : "assistant\.note_deleted"/);

  const brief = src("src/lib/proactiveBrief.ts");
  assert.match(brief, /const review = await briefReviewSection\(tenantId, user\)\.catch\(/);
  assert.match(brief, /data: \{ answer: `\$\{turn\.answer\}\\n\$\{review\}` \}/);

  const wa = src("src/lib/assistantWhatsApp.ts");
  const reply = wa.indexOf("await answerReviewReply(tenantId, user, input.text)");
  assert.ok(reply > wa.indexOf("await confirmFromWhatsApp(tenantId, user, waId, pendingId);"), "after a tapped Confirm");
  assert.ok(reply < wa.indexOf("await answerYes(input.text)"), "before a typed yes and before the ask limit");

  assert.match(src("src/lib/crmAssistant.ts"), /learnedCount > 0 \? await justLearned\(ownedWriteTenantId\(\), user, new Date\(started\)\)/);
  assert.match(src("src/components/AssistantChat.tsx"), /<AssistantLearnedCard name=\{name\} notes=\{turn\.learnedNotes\.notes\} canReview=\{turn\.learnedNotes\.canReview\} \/>/);
  const card = src("src/components/AssistantLearnedCard.tsx");
  assert.match(card, /approveAssistantNote\.bind\(null, note\.id\)/);
  assert.match(card, /onConfirm=\{deleteAssistantNote\.bind\(null, note\.id\)\}/, "Drop asks first, like every removal");
  // Review of #1156: a held CONFLICT is never approved from the chat (that would keep both contradictory entries) — it
  // links to Settings' side-by-side choice; Keep/Drop only for status !== "conflict", and the status is selected.
  assert.match(card, /canReview && note\.status === "conflict" && \([\s\S]*?href="\/settings\/assistant#learned"/);
  assert.match(card, /canReview && note\.status !== "conflict" && \([\s\S]*?approveAssistantNote\.bind/);
  assert.match(lib, /const SELECT = \{[^}]*status: true[^}]*\} as const;/);

  const page = src("src/app/(app)/settings/assistant/page.tsx");
  assert.ok(page.indexOf("<AssistantLearnedReview notes={learned} />") < page.indexOf("action={saveAssistantProfile}"), "first on the page");
  assert.ok(page.indexOf("<AssistantLearnedReview") < page.indexOf("<details"), "not folded under Advanced");
});
