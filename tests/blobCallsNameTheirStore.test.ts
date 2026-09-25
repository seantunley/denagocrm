import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

/**
 * EVERY Blob SDK call names its store.
 *
 * @vercel/blob resolves credentials in this order: an explicit `token`, then
 * OIDC with BLOB_STORE_ID, then BLOB_READ_WRITE_TOKEN. Connecting the private
 * store (2026-09-25) put BLOB_STORE_ID in the environment, pointing at it — so
 * every call without a `token` would have switched from the public store to the
 * private one on the next deploy, and saveFile's `access: "public"` writes, the
 * backups and the backup checks would have gone to the wrong store. Nothing in
 * the code changed; an environment variable did.
 *
 * So no call may rely on the default. Checked on the AST: every call to a name
 * imported from "@vercel/blob" passes an options object with a `token`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Calls to @vercel/blob server functions that do not pass `token`. */
function tokenlessBlobCalls(file: string, text = readFileSync(file, "utf8")): string[] {
  if (!text.includes('from "@vercel/blob"')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imported = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || (statement.moduleSpecifier as ts.StringLiteral).text !== "@vercel/blob") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) if (!el.isTypeOnly) imported.add(el.name.text);
    }
  }
  const bad: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imported.has(node.expression.text)) {
      const hasToken = node.arguments.some(
        (arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "token"),
      );
      if (!hasToken) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        bad.push(`${path.relative(root, file)}:${line + 1} ${node.expression.text}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bad;
}

test("EVERY BLOB SDK CALL NAMES ITS STORE — an env var must not be able to redirect files", () => {
  const files = sourceFiles(path.join(root, "src"));
  const users = files.filter((f) => readFileSync(f, "utf8").includes('from "@vercel/blob"'));
  assert.ok(users.length >= 3, `expected to find the Blob SDK's callers, found ${users.length}`);
  const bad = users.flatMap((file) => tokenlessBlobCalls(file));
  assert.deepEqual(bad, [], `These Blob calls rely on the SDK's default store (BLOB_STORE_ID wins over BLOB_READ_WRITE_TOKEN):\n  ${bad.join("\n  ")}`);
});

test("the checker itself catches a token-less call", () => {
  // Guard against a checker that passes everything.
  const sample = [
    'import { put, list, type ListBlobResultBlob } from "@vercel/blob";',
    'await put("a", b, { access: "public" });',
    'await list({ prefix: "x", token });',
    'const other = { put: (x: string) => x }; other.put("not the SDK");',
  ].join("\n");
  assert.deepEqual(
    tokenlessBlobCalls(path.join(root, "sample.ts"), sample),
    ["sample.ts:2 put()"],
    "the put() without a token is found; the list() with one, and a method named put, are not",
  );
});
