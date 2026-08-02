import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * There were TWO document scopes. `lib/documentAccess.ts` held a near-verbatim
 * copy of the four helpers in `lib/permissions.ts` — same exported names, same
 * `basePrisma.document.findMany` OR-clause — differing only in how they resolved
 * permissions (`hasPermission` twice vs one `scopePermissions` snapshot).
 *
 * The split was by CALLER, which is what made it dangerous. Writes went through
 * permissions.ts; READS — the documents list, global search and
 * `/api/files/[id]` — went through documentAccess.ts. Neither module imported
 * the other, so a fix or a tightening applied to one copy left the other
 * answering the old rule, and the app could say "you may open this file" and
 * "you may not edit this file" from two independently maintained definitions of
 * the same scope. The download endpoint is the sharpest edge: it returns the
 * bytes, so a stale copy there leaks the document itself.
 *
 * These are source-scanning tests because the property is architectural: there
 * must be exactly ONE implementation, and every surface must resolve its answer
 * from it. A behavioural test cannot see a second copy that nobody called yet.
 */

/** The document-scope API. Every name that decides "may this user see it?". */
const SCOPE_API = [
  "getAccessibleDocumentIds",
  "canAccessDocument",
  "requireDocumentReadAccess",
  "requireDocumentAccess",
];

/** The one module allowed to own it. */
const HOME = "src/lib/permissions.ts";

/** Surfaces that hand a document (or its bytes) to a reader. */
const READ_SURFACES = [
  "src/app/(app)/documents/page.tsx",
  "src/app/(app)/search/page.tsx",
  "src/app/api/files/[id]/route.ts",
];

/** Surfaces that mutate one. These must agree with the read surfaces above. */
const WRITE_SURFACES = ["src/app/actions/documents.ts", "src/lib/signing/access.ts"];

/** Every .ts/.tsx module under `dir`, as repo-relative POSIX paths. */
function modulesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...modulesUnder(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Module specifiers a file imports any document-scope helper from. */
function scopeImportSources(rel: string): string[] {
  const sources: string[] = [];
  const importStatement = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (let match; (match = importStatement.exec(shipped(rel))); ) {
    const named = match[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0].trim());
    if (named.some((name) => SCOPE_API.includes(name))) sources.push(match[2]);
  }
  return sources;
}

test("exactly one module defines the document scope", () => {
  const modules = modulesUnder("src");
  for (const fn of SCOPE_API) {
    const definition = new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`);
    const definers = modules.filter((rel) => definition.test(shipped(rel)));
    assert.deepEqual(
      definers,
      [HOME],
      `${fn} must be defined exactly once, in ${HOME} — a second copy is a second rule`,
    );
  }
});

test("the OR-clause over linked records is built in one place", () => {
  // Backstop for the test above: a clone that renamed its exports would keep the
  // giveaway query — `document.findMany` unioning the caller's own uploads with
  // the contact/quote/vehicle/job-card ids they can reach.
  const builders = modulesUnder("src").filter((rel) => {
    const source = shipped(rel);
    return /basePrisma\.document\.findMany/.test(source) && /uploadedById:\s*user\.id/.test(source);
  });
  assert.deepEqual(builders, [HOME], "only one module may compose the document scope query");
});

test("the second copy is gone, not merely unused", () => {
  // Leaving it in the tree as dead code is how it comes back: the next reader
  // sees a module named for exactly what they need and imports it.
  assert.equal(
    existsSync(path.join(root, "src/lib/documentAccess.ts")),
    false,
    "src/lib/documentAccess.ts was the duplicate — it must not exist",
  );
});

test("the read surfaces and the write surfaces ask the same module", () => {
  for (const rel of [...READ_SURFACES, ...WRITE_SURFACES]) {
    const sources = scopeImportSources(rel);
    assert.notEqual(
      sources.length,
      0,
      `${rel} no longer imports a document-scope helper — has it moved, or lost its gate?`,
    );
    for (const source of sources) {
      assert.equal(
        source,
        "@/lib/permissions",
        `${rel} resolves document access from ${source}; the write paths use @/lib/permissions`,
      );
    }
  }
});

test("nothing anywhere resolves document access from a second module", () => {
  // Catches the regression arriving as a NEW module (documentScope.ts,
  // access/documents.ts, …) rather than as the file we just deleted.
  for (const dir of ["src", "scripts"]) {
    for (const rel of modulesUnder(dir)) {
      if (rel === HOME) continue;
      for (const source of scopeImportSources(rel)) {
        assert.equal(
          source.replace(/^.*\//, ""),
          "permissions",
          `${rel} imports document access from ${source} — there is only one scope, and it lives in ${HOME}`,
        );
      }
    }
  }
});

test("the surviving implementation reads permissions once, not twice", () => {
  // The deleted copy called hasPermission() for view_all and again for
  // view_owned: two RBAC round-trips per call, answered from two different
  // snapshots. scopePermissions() returns null for an owner and an empty set
  // when RBAC is unavailable or unconfigured, so one read decides both branches.
  const source = shipped(HOME);
  const start = source.indexOf("export async function getAccessibleDocumentIds(");
  assert.notEqual(start, -1, "getAccessibleDocumentIds not found — was it renamed?");
  const body = source.slice(start, source.indexOf("\nexport async function ", start + 1));
  assert.match(body, /const permissions = await scopePermissions\(user\)/);
  assert.match(body, /permissions === null \|\| permissions\.has\("documents\.view_all"\)/);
  assert.doesNotMatch(body, /hasPermission\(/, "one snapshot decides both branches");
});
