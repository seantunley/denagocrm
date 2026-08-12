import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EVERY `document.create` must stamp `tenantId`.
 *
 * `scopeArgs` injects nothing while enforcement is dormant, so an omitted
 * `tenantId` is a NULL — not a default, and not something the guard fills in
 * later. Under FORCE RLS the Document policy is the standard
 * `bypass_rls OR "tenantId" = current_setting(...)` with no NULL escape hatch,
 * so every one of those rows becomes invisible to the workspace that uploaded
 * it, and `USING` hides it from `UPDATE` too — it cannot be repaired through the
 * app afterwards.
 *
 * This was not a case of nobody thinking about ownership. Eight of the nine call
 * sites resolved the correct tenant, passed it to `saveFile` so the BLOB was
 * filed under the right workspace, and then omitted it from the row — several
 * with a comment above explaining whose the document is. recordSigning.ts even
 * promised it in prose: "and so will the Document row and the SignatureRequest
 * created from it below". The blob and the row disagreed, and only the row was
 * load-bearing for visibility.
 *
 * Asserted by CLASS rather than by listing the nine, so a tenth site added later
 * fails here instead of quietly writing NULLs until the next production sweep.
 */

// fileURLToPath, not `.pathname` — on Windows the latter yields "/C:/…" and ENOENTs.
const ROOT = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Strip comments so an explanatory mention of tenantId cannot satisfy the check. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The `data: { … }` object of a create call, brace-matched from the call site. */
function dataBlock(src: string, from: number): string | null {
  const dataAt = src.indexOf("data:", from);
  if (dataAt === -1) return null;
  const open = src.indexOf("{", dataAt);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

test("every document.create stamps tenantId", () => {
  const offenders: string[] = [];
  let found = 0;

  for (const file of walk(ROOT)) {
    const src = code(readFileSync(file, "utf8"));
    // `.document.create(` on a prisma client or a transaction — NOT the DOM's
    // document.createElement, which is why the dot-prefix and `create(` are exact.
    const re = /\b(?:prisma|basePrisma|tx|transaction)\.document\.create\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      found++;
      const block = dataBlock(src, m.index);
      const where = `${file.replace(/\\/g, "/").split("/src/")[1]} (offset ${m.index})`;
      if (!block) {
        offenders.push(`${where} — could not parse its data block`);
        continue;
      }
      // `tenantId: x` OR the shorthand `tenantId,` / `tenantId }` — the shorthand
      // is the natural spelling once the value is hoisted to feed saveFile too,
      // which is most of these sites.
      if (!/\btenantId\s*[:,}]/.test(block)) offenders.push(where);
    }
  }

  assert.ok(found >= 9, `expected to find at least 9 document.create sites, found ${found} — the matcher has drifted`);
  assert.deepEqual(
    offenders,
    [],
    `document.create without tenantId writes a row that vanishes under RLS and cannot be repaired through the app:\n  ${offenders.join("\n  ")}`,
  );
});
