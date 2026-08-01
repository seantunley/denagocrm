import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Keeps @blocknote pinned, after 0.52.1 made `main` unbuildable.
 *
 * 0.52.1 moved its Yjs packages to OPTIONAL peer dependencies — so npm stops
 * installing them — while `dist/yjs.js` still imports `y-prosemirror`
 * unconditionally, and that module is reachable from the package barrel:
 *
 *     ./node_modules/@blocknote/core/dist/yjs.js
 *     Module not found: Can't resolve 'y-prosemirror'
 *
 *     Import traces:
 *       ./node_modules/@blocknote/server-util/dist/blocknote-server-util.js
 *       ./src/lib/customDocs.ts
 *       ./src/app/api/pdf/doc-editor/[id]/route.ts
 *
 * What this test can and cannot do is worth being exact about, because the
 * obvious version of it does not work. Importing the barrel here does NOT
 * reproduce the failure: Node's ESM loader resolves lazily and never reaches
 * `dist/yjs.js`, while a bundler walks the whole export graph statically. That
 * test was written, run against 0.52.1, observed to PASS, and deleted — a green
 * guard over a broken build is worse than no guard.
 *
 * Only a real `next build` catches this class, and this repo deliberately does
 * not run one in CI (see security-rbac-ci.yml: it defers to Vercel to save
 * Actions minutes). Vercel reports as a commit STATUS rather than a check run,
 * so it does not appear alongside `validate`/`gitleaks`/`guardrails` and has to
 * be read separately — which is exactly how a red build got merged.
 *
 * So this file guards the one thing a unit test genuinely can: that the pin
 * cannot silently float back.
 */
test("blocknote stays exactly pinned until the Yjs peers are handled deliberately", () => {
  // Exact versions, not a caret: "^0.51.4" floats straight back into 0.52.x on
  // the next clean install and breaks the build again with no diff to blame.
  // Lifting this means either installing the optional peers or confirming
  // upstream stopped importing them from the barrel — a decision, not a bump.
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const pinned = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(([name]) => name.startsWith("@blocknote/"));

  assert.ok(pinned.length > 0, "expected @blocknote packages to be present");
  for (const [name, range] of pinned) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} must stay exactly pinned, found "${range}"`);
  }
  // All four must move together — a split version set resolves two copies of
  // the core and its Yjs entry point.
  assert.equal(new Set(pinned.map(([, range]) => range)).size, 1, "all @blocknote packages must share one version");
});

test("the build is still reachable from the doc-editor PDF route", () => {
  // The import chain that made this a build failure rather than a dead
  // dependency. If customDocs stops pulling the server editor, the pin above
  // can be revisited.
  assert.match(read("src/lib/customDocs.ts"), /import\(["']@blocknote\/server-util["']\)/);
});
