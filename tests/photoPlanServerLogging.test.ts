import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const shipped = (file: string) =>
  src(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * "An error occurred in the Server Components render. The specific message is
 * omitted in production builds to avoid leaking sensitive details."
 *
 * That is Next REDACTING a server-side throw. The browser is never told the
 * cause, so no amount of client-side error reporting can record it — which is
 * why the System Log stayed empty through two rounds of improving exactly that.
 *
 * getPhotoUploadPlan threw raw. It is the first server call the uploader makes,
 * so it is the first thing that can fail, and it was the one action in this file
 * that did not go through asActionResult — the helper that logs the REAL error
 * with a reference and returns a message safe to show.
 */

test("the plan action logs its own failure instead of throwing into the void", () => {
  const code = shipped("src/app/actions/photoUploads.ts");
  const plan = code.slice(code.indexOf("export async function getPhotoUploadPlan"));

  assert.match(plan, /asActionResult\(/, "a raw throw is redacted before anyone can record it");
  assert.match(plan, /scope: "photo-upload-plan"/, "the row needs a scope to be findable");
  assert.match(plan, /return \{ error: outcome\.error/, "the safe message must reach the caller");
});

test("the browser shows the reference the server recorded", () => {
  const code = shipped("src/components/DirectPhotoUploader.tsx");
  assert.match(code, /if \("error" in plan\)/, "the error result must be handled, not destructured past");
  assert.match(code, /setProblem\(plan\.error\)/, "that string is all the browser will ever know");

  // And it must be checked BEFORE the plan is used.
  const check = code.indexOf('if ("error" in plan)');
  const use = code.indexOf('plan.transport === "form"');
  assert.ok(check !== -1 && check < use, "using the plan before checking it would throw on the error shape");
});

/*
 * The general rule, not just this instance. A Server Action that throws is
 * redacted in transit; if it does not log for itself, the failure is
 * unrecoverable from either side.
 */
test("every exported action in this file routes failures somewhere recordable", () => {
  const code = shipped("src/app/actions/photoUploads.ts");
  const names = [...code.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 2, "expected both actions here — has the file been split?");

  for (const name of names) {
    const start = code.indexOf(`export async function ${name}`);
    const rest = code.slice(start + 1);
    const next = rest.indexOf("\nexport async function ");
    const body = next === -1 ? rest : rest.slice(0, next);
    assert.ok(
      /asActionResult\(|recordPhotoUploadFailure\(/.test(body),
      `${name} neither logs nor delegates — a throw from it is redacted and lost`,
    );
  }
});

test("the failure reference is written to the System Log, not only the console", () => {
  // A serverless console is not reachable by the person holding the screen, so a
  // console-only reference is a reference to nothing they can open.
  const helper = shipped("src/lib/actionResult.ts");
  assert.match(helper, /logError\(/, "the reference must be persisted");
  assert.match(helper, /failureReference\(\)/, "and be the SAME one shown on screen");
});

test("no other action module bypasses the helper the way this one did", () => {
  // Cheap sweep: an exported action whose body contains no await at all cannot
  // fail asynchronously, but one that awaits and never routes failures is the
  // shape that produced this bug.
  const dir = path.join(process.cwd(), "src", "app", "actions");
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const code = shipped(path.join("src", "app", "actions", file));
    if (!code.includes("getPhotoUploadPlan")) continue; // this file only, for now
    for (const m of code.matchAll(/export async function (\w+)/g)) {
      const start = code.indexOf(`export async function ${m[1]}`);
      const rest = code.slice(start + 1);
      const next = rest.indexOf("\nexport async function ");
      const body = next === -1 ? rest : rest.slice(0, next);
      if (body.includes("await ") && !/asActionResult\(|recordPhotoUploadFailure\(/.test(body)) {
        offenders.push(`${file}#${m[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "these can throw a redacted error that nothing records");
});
