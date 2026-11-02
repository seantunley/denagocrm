import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Flow } from "../src/lib/flow";
import { replayInput, replayMessages } from "../src/lib/flowReplayRun";

// Review 2026-11-02 (Sean's item 3): "why did the bot say that?" — replay a real conversation on the version it ran on.
const flow: Flow = {
  start: "hi",
  nodes: {
    hi: { id: "hi", type: "message", text: "{{greeting}}", next: "menu" },
    menu: { id: "menu", type: "choice", text: "What can we help with?", options: [
      { id: "o1", label: "Book a service appointment", next: "name" },
      { id: "o2", label: "Prices", next: "end" },
    ] },
    name: { id: "name", type: "capture", text: "Your name?", variable: "name", next: "book" },
    book: { id: "book", type: "booking", text: "Booked!", failureText: "Couldn't book.", next: "end", failureNext: "team" },
    team: { id: "team", type: "handoff", text: "Passing you to the team." },
    end: { id: "end", type: "end" },
  },
};

test("a logged tap, voice note or file becomes what the webhook gave the engine", () => {
  const waiting = { nodeId: "menu", vars: {} };
  // WhatsApp cuts a button title to 20 characters; the inbox logs the cut title.
  assert.deepEqual(replayInput("👆 Book a service app", flow, waiting), { text: "Book a service app", choiceId: "menu|o1" });
  assert.deepEqual(replayInput("👆 Prices", flow, waiting), { text: "Prices", choiceId: "menu|o2" });
  assert.deepEqual(replayInput("🎤 (Afrikaans) hallo daar", flow, waiting), { text: "hallo daar" });
  assert.deepEqual(replayInput("🎤 [Voice note]", flow, waiting), { text: "[The customer sent a voice note.]" });
  assert.deepEqual(replayInput("📎 [file]", flow, waiting), { text: "", fileUrl: "[file]" });
  assert.deepEqual(replayInput("hello", flow, waiting), { text: "hello" });
});

test("the path, step numbers and stored values — and an action takes the branch the real one did", async () => {
  const run = await replayMessages(flow, ["hi", "👆 Book a service app", "Thandi"], { vars: { greeting: "Hi there 👋" }, recorded: new Set() });
  assert.deepEqual(run.steps.map((s) => s.nodeId), ["hi", "menu", "name", "book", "team"]);
  assert.deepEqual(run.steps.map((s) => s.order), [1, 2, 3, 4, 5]);
  assert.deepEqual(run.steps.find((s) => s.nodeId === "book")?.changed, { name: "Thandi" });
  assert.equal(run.ended, "handed off", "no booking was recorded, so the replay takes the failure route");
  assert.deepEqual(run.turns.map((t) => t.customer), ["hi", "Book a service app", "Thandi"]);
  assert.deepEqual(run.turns[2].bot, ["Couldn't book.", "Passing you to the team."]);

  const booked = await replayMessages(flow, ["hi", "👆 Book a service app", "Thandi"], { vars: {}, recorded: new Set(["book"]) });
  assert.deepEqual(booked.steps.map((s) => s.nodeId).slice(-2), ["book", "end"]);
  assert.equal(booked.ended, "finished");
  assert.equal(booked.finalVars.name, "Thandi");
});

test("messages after the conversation ended are not replayed", async () => {
  const run = await replayMessages(flow, ["hi", "👆 Prices", "thanks!"], { vars: {}, recorded: new Set() });
  assert.equal(run.turns.length, 2);
  assert.equal(run.ended, "finished");
});

test("owner only, this workspace's flow, nothing sent or written", () => {
  const actions = readFileSync("src/app/actions/flowReplay.ts", "utf8");
  assert.match(actions, /await requireTenantOwner\(\);\s*const row = await prisma\.botFlow\.findFirst\(\{ where: \{ id: flowId, \.\.\.\(await flowScope\(\)\) \}/);
  const run = readFileSync("src/lib/flowReplayRun.ts", "utf8");
  assert.doesNotMatch(run, /from "\.\/(db|botOutbox|whatsapp|flowRuntimeTools)"/, "the replay engine imports nothing that sends or writes");
  const server = readFileSync("src/lib/flowReplay.ts", "utf8");
  assert.doesNotMatch(server, /\.(create|update|upsert|delete)(Many)?\(/, "the replay only reads");
});
