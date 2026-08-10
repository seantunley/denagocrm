import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const flow: Flow = {
  start: "menu",
  nodes: {
    menu: {
      id: "menu",
      type: "choice",
      text: "How can we help?",
      options: [
        { id: "prices", label: "Prices", next: "price" },
        { id: "service", label: "Book a service", next: "service" },
      ],
    },
    price: { id: "price", type: "message", text: "Price route", next: "end" },
    service: { id: "service", type: "message", text: "Service route", next: "end" },
    end: { id: "end", type: "end" },
  },
};

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => {},
  handoff: async () => {},
};

test("free text may select only an existing menu option id", async () => {
  let seenPrompt = "";
  const result = await runFlow(
    flow,
    { nodeId: "menu", vars: {} },
    { text: "my brakes are squeaking and I need to bring it in" },
    {
      ...baseCtx,
      routeChoice: async ({ prompt, options }) => {
        seenPrompt = prompt;
        assert.deepEqual(options.map((option) => option.id), ["prices", "service"]);
        return "service";
      },
    },
  );
  assert.equal(seenPrompt, "How can we help?");
  // Origin node included: routing to "service" must emit the service node's message,
  // which is a stronger claim than the wording alone.
  assert.deepEqual(result.messages, [{ type: "text", nodeId: "service", text: "Service route" }]);
});

test("an invented semantic option id is ignored and the menu is re-shown", async () => {
  const result = await runFlow(
    flow,
    { nodeId: "menu", vars: {} },
    { text: "do something else" },
    { ...baseCtx, routeChoice: async () => "invented" },
  );
  assert.equal(result.session?.nodeId, "menu");
  assert.equal(result.messages[0]?.type, "choice");
});

test("button/list payloads and deterministic label matches do not spend an AI routing call", async () => {
  let calls = 0;
  const ctx: FlowCtx = { ...baseCtx, routeChoice: async () => { calls += 1; return "prices"; } };
  await runFlow(flow, { nodeId: "menu", vars: {} }, { text: "Book a service" }, ctx);
  await runFlow(flow, { nodeId: "menu", vars: {} }, { text: "Prices", choiceId: "menu|prices" }, ctx);
  assert.equal(calls, 0);
});

test("the model router is fenced to high-confidence supplied ids", () => {
  const code = src("src/lib/botAi.ts");
  assert.match(code, /parsed\.confidence !== "high"/);
  assert.match(code, /input\.options\.some\(\(option\) => option\.id === parsed\.optionId\)/);
  assert.match(code, /Never invent an id/);
  assert.doesNotMatch(code, /createBooking|createLeadRecord|reserveSlot/);
});
