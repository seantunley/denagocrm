import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  LEARN_INSTRUCTIONS,
  MEMORY_CHAR_LIMIT,
  conflictsWith,
  inUseWhere,
  isExpired,
  learnBlock,
  memoryPrompt,
  parseUntil,
  planNoteChanges,
  saToday,
  type Entry,
} from "../src/lib/assistantMemory";
import { splitReply } from "../src/lib/assistantReply";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/* ── Conflicts: the heuristic ──────────────────────────────────────────── */

test("who-owns-what: a different owner for the same topic is a conflict", () => {
  assert.equal(conflictsWith("Fleet deals go to Donovan.", "Sean handles fleet accounts."), true);
  assert.equal(conflictsWith("Sean is responsible for fleet accounts", "Fleet deals are handled by Donovan"), true);
  assert.equal(conflictsWith("Golf-estate deals go to Sean.", "Donovan handles all fleet and golf-estate deals."), true);
  assert.equal(conflictsWith("Sean handles all deals.", "Donovan handles quotes."), true, "only generic words on both sides: the same work");
});

test("who-owns-what: agreement, other topics and hedged sentences are NOT conflicts", () => {
  assert.equal(conflictsWith("Donovan prefers short answers.", "Donovan handles fleet deals."), false, "same person, different subject");
  assert.equal(conflictsWith("Donovan handles fleet deals.", "Donovan prefers short answers."), false);
  assert.equal(conflictsWith("Fleet deals go to Donovan.", "Donovan handles all fleet deals."), false, "says the same thing");
  assert.equal(conflictsWith("Sean Tunley handles fleet deals.", "Sean handles fleet deals."), false, "one person, full name");
  assert.equal(conflictsWith("Sean handles fleet servicing.", "Donovan handles fleet deals."), false, "servicing isn't sales");
  assert.equal(conflictsWith("Sean handles fleet deals when Donovan is away.", "Donovan handles fleet deals."), false, "a condition: unsure, so no");
  assert.equal(conflictsWith("Sean handles fleet deals; Donovan handles the rest.", "Donovan handles fleet deals."), false);
  assert.equal(conflictsWith("We handle fleet deals in-house.", "Donovan handles fleet deals."), false, "'We' isn't a person");
  assert.equal(conflictsWith("Sean handles golf-estate deals.", "Donovan handles fleet deals."), false);
});

test("the same statement flipped or re-numbered is a conflict; a different statement isn't", () => {
  assert.equal(conflictsWith("We don't deliver on Saturdays.", "We deliver on Saturdays."), true);
  assert.equal(conflictsWith("Quotes go out within 48 hours.", "Quotes go out within 24 hours."), true);
  assert.equal(conflictsWith("Never discount Rover XL more than 3%.", "Don't discount Rover XL more than 5%."), true);
  assert.equal(conflictsWith("Donovan doesn't handle fleet deals.", "Donovan handles fleet deals."), true);

  assert.equal(conflictsWith("Quotes go out within 24 hours.", "Quotes go out within 24 hours"), false, "the same");
  assert.equal(conflictsWith("Sean prefers email.", "Sean prefers WhatsApp to email."), false);
  assert.equal(conflictsWith("We deliver on Saturdays.", "We open on Saturdays."), false);
  assert.equal(conflictsWith("Quotes go out within 24 hours.", "Invoices go out within 48 hours."), false);
  assert.equal(conflictsWith("Prefers short answers.", "Prefers bullet points."), false);
});

/* ── Conflicts: what learning does with them ───────────────────────────── */

const approved: Entry = { id: "a", content: "Sean handles fleet accounts.", status: "approved" };

test("new learning that contradicts an approved entry is held, pointing at it", () => {
  assert.deepEqual(planNoteChanges([approved], [{ add: "Fleet deals go to Donovan." }], MEMORY_CHAR_LIMIT), [
    { kind: "create", content: "Fleet deals go to Donovan.", conflictsWithId: "a" },
  ]);
  // Not a conflict → ordinary unreviewed learning.
  assert.deepEqual(planNoteChanges([approved], [{ add: "Donovan prefers short answers." }], MEMORY_CHAR_LIMIT), [
    { kind: "create", content: "Donovan prefers short answers." },
  ]);
  // A rewrite of its own unreviewed entry into a contradiction is held too.
  const mine: Entry = { id: "b", content: "Quotes go out within 24 hours.", status: "unreviewed" };
  assert.deepEqual(
    planNoteChanges([approved, mine], [{ replace: { old: "24 hours", new: "Fleet deals go to Donovan." } }], MEMORY_CHAR_LIMIT),
    [{ kind: "update", id: "b", content: "Fleet deals go to Donovan.", conflictsWithId: "a" }],
  );
});

test("one open question per approved entry, and a held entry can't be rewritten or removed by the model", () => {
  const held: Entry = { id: "h", content: "Fleet deals go to Donovan.", status: "conflict", conflictsWithId: "a" };
  assert.deepEqual(planNoteChanges([approved, held], [{ add: "Donovan is responsible for fleet deals." }], MEMORY_CHAR_LIMIT), [], "already asked");
  assert.deepEqual(planNoteChanges([approved, held], [{ replace: { old: "Donovan", new: "Fleet deals go to Ben." } }], MEMORY_CHAR_LIMIT), []);
  assert.deepEqual(planNoteChanges([approved, held], [{ remove: "go to Donovan" }], MEMORY_CHAR_LIMIT), []);
  assert.deepEqual(planNoteChanges([approved, held], [{ add: "Fleet deals go to Donovan." }], MEMORY_CHAR_LIMIT), [], "duplicate");
});

test("the store holds a conflict out of prompts and never lets learning rewrite one", () => {
  const store = code("src/lib/assistantMemoryStore.ts");
  assert.match(store, /status: change\.conflictsWithId \? "conflict" : "unreviewed", conflictsWithId: change\.conflictsWithId \?\? null/);
  assert.match(store, /const notOwners = \{ notIn: \["approved", "conflict"\] \};/);
  assert.match(store, /updateMany\(\{ where: \{ id: change\.id, \.\.\.where, status: notOwners \}/);
  assert.match(store, /deleteMany\(\{ where: \{ id: change\.id, \.\.\.where, status: notOwners \} \}\)/);
  // The tidy-up doesn't see held or expired entries, so a merge can't release one.
  assert.match(code("src/lib/assistantTidy.ts"), /where: \{ \.\.\.inUseWhere\(\), kind: \{ not: "profile" \} \}/);
});

test("the owner settles a conflict — owner only, under the lock, only the paired entry, audited without text", () => {
  const actions = code("src/app/actions/assistantNotes.ts");
  const resolve = actions.slice(actions.indexOf("export async function resolveAssistantConflict"), actions.indexOf("export async function saveMyAssistantNote"));
  assert.match(resolve, /const user = await requireTenantOwner\(\);/);
  assert.match(resolve, /pg_advisory_xact_lock\(hashtext\(\$\{`assistant-notes:\$\{tenantId\}`\}\)::bigint\)/);
  assert.match(resolve, /findFirst\(\{ where: \{ id, status: "conflict" \}/);
  assert.match(resolve, /deleteMany\(\{ where: \{ id: held\.conflictsWithId, kind: held\.kind, userId: held\.userId \} \}\)/);
  assert.match(resolve, /action: "assistant\.conflict_resolved"/);
  assert.doesNotMatch(resolve, /summary:[^\n]*content/, "the trail never copies what either entry says");
});

/* ── Expiry ────────────────────────────────────────────────────────────── */

test("until: a real day only; a bad one drops the expiry, never the lesson; old shapes still parse", () => {
  assert.equal(parseUntil("2026-10-31")?.toISOString(), "2026-10-31T00:00:00.000Z");
  for (const bad of ["2026-02-31", "31/10/2026", "2026-13-01", "soon", ""]) assert.equal(parseUntil(bad), null, bad);

  const parsed = learnBlock.parse({
    memory: [
      { add: "For October, don't discount Rover XL more than 3%.", until: "2026-10-31" },
      { replace: { old: "Rover", new: "Rover XL discounts are capped at 3% this month." }, until: "2026-10-31" },
      { add: "Quotes go out within 24 hours.", until: "next month" },
      { add: "Sean prefers WhatsApp." },
      { remove: "old rule" },
    ],
  });
  assert.equal(parsed.memory?.[0] && "add" in parsed.memory[0] ? parsed.memory[0].until : null, "2026-10-31");
  assert.equal(parsed.memory?.[2] && "add" in parsed.memory[2] ? parsed.memory[2].until : "x", undefined, "bad date dropped, op kept");
  assert.deepEqual(parsed.memory?.[3], { add: "Sean prefers WhatsApp." }, "no until → same shape as before");

  // In the reply block it arrives the same way.
  const reply = splitReply('Noted.\n<<DAX>>\n{"learn":{"memory":[{"add":"For October, cap Rover XL discounts at 3%.","until":"2026-10-31"}]}}');
  assert.deepEqual(reply.learn?.memory, [{ add: "For October, cap Rover XL discounts at 3%.", until: "2026-10-31" }]);
  assert.match(LEARN_INSTRUCTIONS, /"until":"YYYY-MM-DD"/);
  assert.match(LEARN_INSTRUCTIONS, /under "learn" in the reply block/, "the existing key structure is kept");
});

test("an until on an op travels with the change", () => {
  assert.deepEqual(planNoteChanges([], [{ add: "For October, cap Rover XL discounts at 3%.", until: "2026-10-31" }], MEMORY_CHAR_LIMIT), [
    { kind: "create", content: "For October, cap Rover XL discounts at 3%.", until: "2026-10-31" },
  ]);
});

test("expired = past its last day in South Africa; the last day itself still counts", () => {
  const until = parseUntil("2026-10-31")!;
  // 23:30 UTC on the 31st is already 1 November in Johannesburg.
  assert.equal(saToday(new Date("2026-10-31T23:30:00Z")).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(isExpired(until, new Date("2026-10-31T21:00:00Z")), false, "23:00 SAST on the last day");
  assert.equal(isExpired(until, new Date("2026-10-31T22:30:00Z")), true, "00:30 SAST the day after");
  assert.equal(isExpired(null), false);
  // The prompt filter: no conflicts, and validUntil empty or not before today.
  assert.deepEqual(inUseWhere(new Date("2026-10-31T22:30:00Z")), {
    status: { not: "conflict" },
    AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: new Date("2026-11-01T00:00:00Z") } }] }],
  });
});

test("every prompt read leaves held and expired entries out; the prompt says when a rule ends", () => {
  const store = code("src/lib/assistantMemoryStore.ts");
  const load = store.slice(store.indexOf("export async function loadLearned"), store.indexOf("export async function markNotesUsed"));
  assert.match(load, /\{ \.\.\.inUse, kind: "memory", \.\.\.visibleTo\(userId\) \}/);
  assert.match(load, /\{ \.\.\.inUse, kind: "profile", userId \}/);
  assert.match(load, /\{ \.\.\.inUse, kind: "playbook", \.\.\.visibleTo\(userId\) \}/);
  assert.match(load, /where: \{ \.\.\.inUseWhere\(\), kind: "playbook", name:/, "loading a playbook by name too");
  const text = memoryPrompt({
    memory: [{ id: "a", content: "Cap Rover XL discounts at 3%.", status: "approved", validUntil: parseUntil("2026-10-31") }],
    profile: [],
    playbooks: [],
  });
  assert.match(text, /- Cap Rover XL discounts at 3%\. \(until 2026-10-31\)$/m);
});

/* ── Provenance ────────────────────────────────────────────────────────── */

test("each write says where it came from, and approval/edit stamps the confirmation", () => {
  const store = code("src/lib/assistantMemoryStore.ts");
  assert.equal(store.match(/source: userId \? "learned" : "tidy"/g)?.length, 2, "notes and playbooks");
  assert.match(code("src/lib/assistantTidy.ts"), /createdById: null, source: "tidy"/);
  const actions = code("src/app/actions/assistantNotes.ts");
  assert.match(actions, /source: "owner"/);
  assert.match(actions, /source: "person"/);
  for (const fn of ["approveAssistantNote", "updateAssistantNote"]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 2000), /lastConfirmedAt: now/, fn);
  }
  // markNotesUsed exists for the answer path; it never throws into it.
  assert.match(store, /export async function markNotesUsed\(ids: string\[\]\): Promise<void>/);
  assert.match(store, /\.catch\(async \(error: unknown\) => \{\s*await logError\("assistant-memory", "marking notes used failed", error instanceof Error \? error\.name : "unknown"\);/);
});

test("the migration is additive and re-runnable", () => {
  const sql = readFileSync(new URL("../prisma/migrations/20261007091000_assistant_note_provenance/migration.sql", import.meta.url), "utf8");
  for (const column of ["source", "lastConfirmedAt", "validUntil", "lastUsedAt", "conflictsWithId"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`), column);
  }
  assert.doesNotMatch(sql, /\b(DROP (TABLE|COLUMN)|CREATE TABLE|DELETE FROM|TRUNCATE)\b/i);
  assert.match(sql, /SET app\.bypass_rls = 'on';[\s\S]*RESET app\.bypass_rls;/);
});
