import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd());
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped, so a rule cannot be satisfied by prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * PER-CARD STREAMING, AND THE GUARANTEE IT MUST NOT COST.
 *
 * Cards already loaded in parallel, but `renderViewSlots` was awaited in full
 * before the page rendered anything — so the whole dashboard cost the SLOWEST
 * query. One report card against a large table held up the agenda and every tile
 * that was ready in milliseconds.
 *
 * Streaming fixes that and puts the dashboard's strongest guarantee at risk in
 * the same move. "One bad card costs exactly one card" worked because a card was
 * awaited on the server, where a try/catch could see it fail. A card that
 * resolves AFTER the shell has been sent throws past that catch, into the
 * nearest React error boundary — which, without one per card, is the page.
 *
 * These tests are source contracts for the same reason dashboardView.test.ts is:
 * the renderer imports `server-only` and a PrismaClient and cannot be imported
 * into a test process at all.
 */

const VIEW = "src/components/dashboard/DashboardView.tsx";

test("a card is streamed only when its visibility needs no data", () => {
  const source = code(VIEW);
  // The gate. A card whose rule depends on its own signals cannot be streamed:
  // deciding whether it appears at all requires loading it first.
  assert.match(
    source,
    /if\s*\(isServerDecidable\(card\.visibility\)\)\s*\{/,
    "streaming must be gated on the visibility being decidable without the card's data",
  );
});

test("a data-dependent card is still awaited and still condition-checked", () => {
  const source = code(VIEW);
  // The old path must survive intact for "hide when empty" to keep working.
  assert.match(source, /result = await renderCard\(card, render\)/);
  assert.match(
    source,
    /conditionsMet\(card\.visibility,\s*\{\s*\.\.\.ctx,\s*signals:\s*result\.signals\s*\}\)/,
    "the signals check is what a data-dependent rule is for",
  );
});

test("every streamed card carries its own error boundary AND a suspense fallback", () => {
  const source = code(VIEW);
  const streamed = source.slice(source.indexOf("isServerDecidable(card.visibility)"));
  const block = streamed.slice(0, streamed.indexOf("return;"));

  assert.match(block, /<CardBoundary/, "without this, one late failure takes the page");
  assert.match(block, /<Suspense/, "without this there is nothing to stream into");
  assert.match(block, /fallback=\{<CardSkeleton/, "a fallback is what stops the grid reflowing");

  // Order matters: the boundary must be OUTSIDE the Suspense, or a throw while
  // resolving escapes it.
  assert.ok(
    block.indexOf("<CardBoundary") < block.indexOf("<Suspense"),
    "the boundary must wrap the Suspense, not the other way round",
  );
});

test("the streamed card returns null rather than throwing on a failed load", () => {
  const source = code(VIEW);
  const fn = source.slice(source.indexOf("async function StreamedCard"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /try\s*\{/, "a failed load must not reach the boundary as a crash");
  assert.match(body, /catch\s*\{[\s\S]*?return null/, "…it degrades to nothing, as before");
});

test("the card boundary uses the framework primitive, not a hand-rolled class", () => {
  /*
   * The first version was a class component with getDerivedStateFromError. That
   * is the classic way to write a boundary and it is wrong here in ways that are
   * easy to miss:
   *
   *   - redirect() and notFound() work by THROWING. A custom boundary catches
   *     them like any other failure, so a card that redirects would render
   *     "could not be loaded" instead of redirecting.
   *   - a class can only clear its own error state, which cannot recover a
   *     Server Component error — the card fails again immediately.
   *
   * See node_modules/next/dist/docs/.../catchError.md.
   */
  const boundary = code("src/components/dashboard/CardBoundary.tsx");
  assert.match(boundary, /catchError/, "use the framework's boundary");
  assert.match(boundary, /from "next\/error"/);
  assert.match(boundary, /"use client"/, "an error boundary cannot be a server component");
  assert.doesNotMatch(
    boundary,
    /getDerivedStateFromError|componentDidCatch/,
    "a hand-rolled class swallows redirect() and notFound()",
  );
});

test("a contained card failure still reaches the server", () => {
  // The observability regression in the first version: componentDidCatch wrote
  // to the browser console and nowhere else, so a card could fail for every user
  // of a tenant and leave no trace anywhere. Containment must not mean silence.
  const boundary = code("src/components/dashboard/CardBoundary.tsx");
  assert.match(boundary, /\/api\/client-error/, "report to the same endpoint the page boundary uses");
  assert.match(boundary, /keepalive/, "the report must survive a navigation away");
  assert.match(boundary, /\.catch\(\(reportError\) => \{/, "a failing reporter must not break the fallback");
  assert.match(boundary, /\[client-error-report-failure\]/, "reporting failure must remain visible in the browser console");
  assert.match(boundary, /dashboard card/, "the log line must say which card");
});

test("a failed card can be retried on its own", () => {
  // retry re-fetches and re-renders just this boundary's children, so
  // one failed card does not need a whole-page reload to recover.
  const boundary = code("src/components/dashboard/CardBoundary.tsx");
  assert.match(boundary, /retry\(\)/);
});

test("a failed card says nothing about why", () => {
  // A card that failed on a row the viewer should never have seen must not
  // describe that row on its way out — the same rule renderCard's catch follows.
  const boundary = code("src/components/dashboard/CardBoundary.tsx");
  assert.match(boundary, /could not be loaded/i);
  // The message goes to the SERVER log, never into the rendered output.
  const rendered = boundary.slice(boundary.indexOf("return ("));
  assert.doesNotMatch(rendered, /error\.message|error\.stack|String\(error\)/, "no detail on screen");
});

test("the skeleton reserves height so the grid does not jump", () => {
  const skeleton = code("src/components/dashboard/CardSkeleton.tsx");
  assert.match(skeleton, /min-h-/, "a zero-height placeholder reflows the grid when it resolves");
  assert.match(skeleton, /aria-busy/, "…and screen readers should know it is loading");
});

test("a card that resolves to nothing does not hold a grid cell open", () => {
  /*
   * The regression this covers, reported from the preview as "still big spaces".
   *
   * Before streaming, a card the server drew nothing for had NO SLOT, so
   * SortableCard's `node === undefined` guard returned null and it took no
   * space. Streaming gives every server-decidable card a slot up front — an
   * element that may resolve to nothing once its query returns — so the guard
   * stopped firing and the grid reserved a cell for a card drawing nothing.
   *
   * The guard cannot know the answer up front, so the collapse has to happen
   * after it resolves. `:empty` matches an element with no child nodes at all,
   * which is exactly the state a resolved-to-nothing card leaves behind.
   */
  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");

  assert.match(canvas, /!editing && "empty:hidden"/, "an empty card must collapse when not editing");

  // …and the node must be rendered with NO intermediate wrapper outside edit
  // mode, or the wrapper is never empty and the rule above never matches.
  const card = canvas.slice(canvas.indexOf("function SortableCard"));
  assert.match(card, /\{editing \? \(/, "the wrapper div must be edit-mode only");
  assert.match(card, /\) : \(\s*node\s*\)\}/, "outside edit mode the node renders directly");

  // While editing, an empty card is still something to select — it keeps its
  // placeholder rather than vanishing out from under the person editing it.
  assert.match(card, /node \?\? <CardPlaceholder/);
});
