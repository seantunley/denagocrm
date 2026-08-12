import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * The engine gained three-state action outcomes — succeeded, failed, and "the
 * request was fine, there is just no capacity" — and the inspector gained fields
 * to route each one. The CANVAS drew only the success edge.
 *
 * So an operator looking at a booking flow saw an apparently-linear diagram whose
 * failure branch was invisible: no way to tell a node whose failure is handled
 * from one whose is not, and no way to see where a failure goes. A graph you
 * cannot read off the diagram is not a visual builder.
 */

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => ({ ok: true }),
  handoff: async () => {},
};

test("the three outcomes the canvas must draw are three genuinely different routes", async () => {
  // Not a rendering detail: these land the customer in three different places.
  const flow: Flow = {
    start: "book",
    nodes: {
      book: { id: "book", type: "booking", action: "service", text: "Booked!", next: "ok", failureNext: "sorry", unavailableNext: "callback" },
      ok: { id: "ok", type: "message", text: "See you then." },
      sorry: { id: "sorry", type: "message", text: "Something went wrong." },
      callback: { id: "callback", type: "message", text: "We'll call you." },
    },
  };
  const ran = async (outcome: { ok: boolean; unavailable?: boolean }) => {
    const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, {
      ...baseCtx,
      createBooking: async () => outcome,
    });
    return result.messages.map((m) => (m.type === "text" ? m.text : "")).join(" ");
  };
  assert.match(await ran({ ok: true }), /See you then/);
  assert.match(await ran({ ok: false }), /Something went wrong/);
  assert.match(await ran({ ok: false, unavailable: true }), /We'll call you/);
});

test("the canvas draws the failure and unavailable routes, visibly distinct", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  const edges = builder.slice(builder.indexOf("const edges: Edge[] = useMemo"), builder.indexOf("const onConnect"));
  assert.match(edges, /add\("failure", routed\.failureNext/, "a failure route must be drawn");
  assert.match(edges, /add\("unavailable", routed\.unavailableNext/, "so must an unavailable route");
  // Same colour as `next` would make them drawn but not readable.
  assert.match(edges, /label: "fails"[\s\S]{0,80}stroke: "#f59e0b"/);
  assert.match(edges, /label: "none available"[\s\S]{0,120}strokeDasharray/);
});

test("the edges come from the graph, not from what the inspector can author", () => {
  // The inspector offers `unavailableNext` on slots only, but the AI drafter,
  // shipped templates and reusable blocks can all produce one on a booking node.
  // Reading the data means such a graph still shows every edge it has.
  const builder = src("src/components/FlowBuilder.tsx");
  const edges = builder.slice(builder.indexOf("const edges: Edge[] = useMemo"), builder.indexOf("const onConnect"));
  assert.match(edges, /const routed = n as \{ failureNext\?: string; unavailableNext\?: string \}/);
  assert.doesNotMatch(edges, /FALLIBLE\.has/, "drawing must not be gated on the authorable set");
});

test("a fallible node offers a handle per outcome", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  const card = builder.slice(builder.indexOf("function NodeCard"), builder.indexOf("const nodeTypes"));
  assert.match(card, /FALLIBLE\.has\(n\.type\)/, "fallible nodes need their own card body");
  for (const id of ["out", "failure", "unavailable"]) {
    assert.match(card, new RegExp(`id="${id}"`), `no source handle for "${id}"`);
  }
  // The unavailable handle must appear wherever THIS node carries the route, not
  // only on slots — see the render-contract test below.
  assert.match(card, /n\.type === "slots" \|\| Boolean\(\(n as \{ unavailableNext\?: string \}\)\.unavailableNext\)/);
});

/**
 * The edge builder and the card have to agree, and the previous tests proved each
 * half on its own: that an unavailable edge is drawn from graph data, and that
 * SOME node renders an unavailable handle. Both passed while they disagreed —
 * a booking node carrying unavailableNext produced an edge with
 * `sourceHandle: "unavailable"` and no handle of that id to anchor it to.
 *
 * Model the contract itself: for every edge the builder emits, the node it leaves
 * must expose that handle.
 */
type TestNode = { id: string; type: string; next?: string; failureNext?: string; unavailableNext?: string };

/** The edge builder's rule, as shipped. */
function edgesFor(node: TestNode): string[] {
  const handles: string[] = [];
  if (node.type !== "handoff" && node.type !== "end" && node.next) handles.push("out");
  if (node.failureNext) handles.push("failure");
  if (node.unavailableNext) handles.push("unavailable");
  return handles;
}

/** The card's rule, as shipped. */
function handlesOn(node: TestNode): string[] {
  const FALLIBLE_TYPES = ["booking", "slots", "journey"];
  if (!FALLIBLE_TYPES.includes(node.type)) return node.type === "handoff" || node.type === "end" ? [] : ["out"];
  const handles = ["out", "failure"];
  if (node.type === "slots" || Boolean(node.unavailableNext)) handles.push("unavailable");
  return handles;
}

test("every edge the builder draws leaves a handle the card actually renders", () => {
  // A booking node with unavailableNext is the case that was broken: the AI
  // drafter, the shipped templates and reusable blocks can all produce one, and
  // the Flow model and actionOutcome() both accept it.
  const graphs: TestNode[] = [
    { id: "book", type: "booking", next: "ok", failureNext: "sorry", unavailableNext: "callback" },
    { id: "book2", type: "booking", next: "ok", failureNext: "sorry" },
    { id: "slots", type: "slots", next: "ok", failureNext: "sorry", unavailableNext: "callback" },
    { id: "journey", type: "journey", next: "ok", failureNext: "sorry", unavailableNext: "callback" },
    { id: "msg", type: "message", next: "ok" },
    { id: "stop", type: "end" },
  ];
  for (const node of graphs) {
    const available = handlesOn(node);
    for (const handle of edgesFor(node)) {
      assert.ok(
        available.includes(handle),
        `${node.type} "${node.id}" draws a "${handle}" edge from a handle it does not render (has: ${available.join(", ") || "none"})`,
      );
    }
  }
});

test("dragging from a failure handle does not silently wire the success route", () => {
  // The connect handler fell through to `{ ...n, next: target }` for any unknown
  // handle. Dragging "if it fails" would have wired it to the node that tells the
  // customer it worked — the exact graph the publish compiler exists to refuse.
  const builder = src("src/components/FlowBuilder.tsx");
  const connect = builder.slice(builder.indexOf("const onConnect"), builder.indexOf("function addNode"));
  const failureAt = connect.indexOf('c.sourceHandle === "failure"');
  const unavailableAt = connect.indexOf('c.sourceHandle === "unavailable"');
  const fallthroughAt = connect.indexOf("return { ...n, next: c.target! }");
  assert.ok(failureAt > 0 && failureAt < fallthroughAt, "failure must be handled before the fallthrough");
  assert.ok(unavailableAt > 0 && unavailableAt < fallthroughAt, "so must unavailable");
  assert.match(connect, /failureNext: c\.target!/);
  assert.match(connect, /unavailableNext: c\.target!/);
});

test("deleting a node clears every edge that pointed at it, not just the success one", () => {
  // A dangling failureNext is a publish error now, so leaving one behind would
  // make deleting a node break publication with no visible cause.
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /if \(routed\.failureNext === removedId\) cleared\.failureNext = undefined;/);
  assert.match(builder, /if \(routed\.unavailableNext === removedId\) cleared\.unavailableNext = undefined;/);
});

test("no handle inside a row carries a card-relative offset", () => {
  /*
   * THE VISUAL BUG, stated as a rule.
   *
   * Every branch handle on a node card lives inside its own `relative` row, so
   * an absolute `top` on the handle resolves against THAT ROW — not the card.
   * The offsets were card-relative (`92px`, `118px`, `144px`, `100 + i*26`), so
   * each dot was thrown roughly its own value BELOW its row and landed outside
   * the card, dragging its edge's anchor into empty canvas with it. On screen it
   * read as two loose coloured dots floating under the node and an edge starting
   * from nowhere.
   *
   * Left alone, React Flow centres a handle in its positioning parent, which is
   * exactly the row holding the label. That is also the only form that survives a
   * wrapped option label or a taller summary block; a fixed pixel offset is wrong
   * again the moment any row above it changes height, which is why this is a rule
   * rather than six corrected numbers.
   */
  const src = readFileSync(
    path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "src/components/FlowBuilder.tsx"),
    "utf8",
  );

  const handles = src.match(/<Handle[^>]*>/g) ?? [];
  assert.ok(handles.length >= 6, `expected the branch handles, found ${handles.length}`);

  const offenders = handles.filter((h) => /\btop:\s*[`"']?\$?\{?\s*\d/.test(h));
  assert.deepEqual(
    offenders,
    [],
    "a handle sets an absolute top; inside its relative row that is measured from the ROW, " +
      "so any card-relative value puts the dot outside the card:\n" + offenders.join("\n"),
  );
});
