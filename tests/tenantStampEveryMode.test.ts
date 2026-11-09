import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { fillMissingTenant } from "../src/lib/tenantGuard";

/**
 * A NEW ROW GETS ITS WORKSPACE IN EVERY MODE (2026-11-09) — the unit half; the database half, with enforcement
 * off and on, is scripts/test-stamp-every-mode.ts.
 */

test("fill: a row with no tenantId gets the scope's, one row or many", () => {
  assert.deepEqual(fillMissingTenant({ data: { a: 1 } }, "data", "t1"), { data: { a: 1, tenantId: "t1" } });
  assert.deepEqual(fillMissingTenant({ data: [{ a: 1 }, { a: 2 }] }, "data", "t1"), { data: [{ a: 1, tenantId: "t1" }, { a: 2, tenantId: "t1" }] });
  assert.deepEqual(fillMissingTenant({ where: { id: "x" }, create: { a: 1 }, update: {} }, "create", "t1"), { where: { id: "x" }, create: { a: 1, tenantId: "t1" }, update: {} });
});

test("fill: a tenantId the caller named — even null — is never overridden", () => {
  assert.deepEqual(fillMissingTenant({ data: { tenantId: "t2" } }, "data", "t1"), { data: { tenantId: "t2" } });
  assert.deepEqual(fillMissingTenant({ data: { tenantId: null } }, "data", "t1"), { data: { tenantId: null } });
  assert.deepEqual(fillMissingTenant({ data: [{ tenantId: "t2" }, {}] }, "data", "t1"), { data: [{ tenantId: "t2" }, { tenantId: "t1" }] });
});

test("the guard stamps creates while NOT enforcing, from the scope only, never a guessed tenant", () => {
  const db = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8");
  assert.match(db, /if \(!tenantEnforcing\(\)\) return stampWhileNotEnforcing\(model, kind, args\);/);
  const fn = db.slice(db.indexOf("function stampWhileNotEnforcing("), db.indexOf("function refuseNestedRelationWrite("));
  assert.match(fn, /if \(kind !== "create" && kind !== "upsert"\) return args;/);
  assert.match(fn, /if \(!scope \|\| scope\.system \|\| !scope\.tenantId\) return args;/);
  assert.match(fn, /fillMissingTenant\(args, kind === "upsert" \? "create" : "data", scope\.tenantId\)/);
  assert.doesNotMatch(fn, /DEFAULT_TENANT_ID/);
});

test("an audit entry takes the workspace the work runs in before the cookie check", () => {
  const audit = readFileSync(new URL("../src/lib/audit.ts", import.meta.url), "utf8");
  const fn = audit.slice(audit.indexOf("async function actingTenantId("), audit.indexOf("async function auditTenantIds("));
  assert.ok(fn.indexOf("currentTenantScope()") < fn.indexOf("getCurrentUser()"));
  assert.match(fn, /if \(scope && !scope\.system && scope\.tenantId\) return scope\.tenantId;\s*if \(!entry\.user\) return null;/);
});

/**
 * basePrisma bypasses the guard entirely — in every mode — so a create there that names no workspace writes NULL
 * even in production. None does today; this keeps it that way. Literal `data` objects only: a computed payload
 * can't be read statically, and is covered where it is built.
 */
test("no basePrisma create on a tenant-owned model leaves out tenantId", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const models = new Set<string>();
  for (const file of readdirSync(join(root, "prisma")).filter((name) => name.endsWith(".prisma"))) {
    const text = readFileSync(join(root, "prisma", file), "utf8");
    for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) if (/^\s+tenantId\s/m.test(m[2])) models.add(m[1][0].toLowerCase() + m[1].slice(1));
  }
  assert.ok(models.size > 100, `read ${models.size} tenant-owned models`);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(root, "src"));
  const missing: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("basePrisma")) continue;
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["create", "createMany", "createManyAndReturn", "upsert"].includes(node.expression.name.text)) {
        const target = node.expression.expression;
        if (ts.isPropertyAccessExpression(target) && models.has(target.name.text) && target.expression.getText() === "basePrisma") {
          const arg = node.arguments[0];
          const key = node.expression.name.text === "upsert" ? "create" : "data";
          const prop = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find((p) => p.name?.getText() === key) : undefined;
          const data = prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
          if (data && ts.isObjectLiteralExpression(data)) {
            const named = data.properties.some((p) => ts.isSpreadAssignment(p) || p.name?.getText() === "tenantId");
            if (!named) missing.push(`${file.slice(root.length)}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${target.name.text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  assert.deepEqual(missing, [], `basePrisma creates with no tenantId:\n${missing.join("\n")}`);
});
