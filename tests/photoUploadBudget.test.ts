import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  PHOTO_MAX_EDGE,
  SERVER_ACTION_BODY_LIMIT,
  checkUploadPayload,
  fitWithinMaxEdge,
} from "../src/lib/photoBudget";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The camera flow could not have worked on a phone.
 *
 * A Server Action request body is capped at 1 MB by default and next.config.ts
 * declared no limit, while the upload actions advertise twelve photos of up to
 * 4 MB each. An ordinary phone photo is 3–12 MB, so the framework rejected the
 * request before uploadJobCardPhotos ran any of its careful per-file validation.
 * It reviewed fine on a desktop, where `capture="environment"` is ignored and a
 * picked file is usually small.
 *
 * Two numbers were incoherent (1 MB allowed, 48 MB advertised) and nothing in the
 * repo compared them. These tests compare them.
 */

const MB = 1024 * 1024;

test("the declared request limit is larger than the payload we enforce", () => {
  // The incoherence, pinned. The request also carries form fields and multipart
  // boundaries, so the enforced total must leave headroom under the declared
  // limit — otherwise a payload we accept is one the framework refuses, and the
  // person sees a generic failure instead of our explanation.
  const declared = /^(\d+)mb$/.exec(SERVER_ACTION_BODY_LIMIT);
  assert.ok(declared, `the limit must be a plain mb value, got ${SERVER_ACTION_BODY_LIMIT}`);
  const declaredBytes = Number(declared[1]) * MB;
  assert.ok(
    MAX_UPLOAD_TOTAL_BYTES < declaredBytes,
    `enforced total ${MAX_UPLOAD_TOTAL_BYTES} must be under declared ${declaredBytes}`,
  );
});

test("next.config.ts actually declares the limit", () => {
  // A constant nothing reads changes nothing. This is the one place the framework
  // looks, and it was empty.
  const config = src("next.config.ts");
  assert.match(config, /serverActions:\s*\{\s*bodySizeLimit:\s*"(\d+mb)"/, "the limit must be configured");
  const configured = /bodySizeLimit:\s*"(\d+mb)"/.exec(config)?.[1];
  assert.equal(configured, SERVER_ACTION_BODY_LIMIT, "config and photoBudget must agree");
});

test("a full batch of resized photos fits inside the enforced total", () => {
  // The budget has to be self-consistent: the most photos we accept, at the size
  // resizing actually produces, must pass. A 1600px JPEG at q0.82 is comfortably
  // under 1 MB; 800 KB is a pessimistic stand-in.
  const resized = Array.from({ length: MAX_PHOTOS }, () => 800 * 1024);
  const verdict = checkUploadPayload(resized);
  assert.equal(verdict.ok, true, `a full batch must fit: ${JSON.stringify(verdict)}`);
});

test("a full batch of UNRESIZED phone photos is refused, with a reason", () => {
  // What used to happen silently at the framework layer now happens here, where
  // there is something to say about it.
  const originals = Array.from({ length: MAX_PHOTOS }, () => 3.5 * MB);
  const verdict = checkUploadPayload(originals);
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok);
  assert.match(verdict.reason, /two batches|limit/i, "the refusal must say what to do");
  assert.match(verdict.reason, /MB/, "and be in the unit a phone gallery shows");
});

test("too many photos, and a single oversize photo, are each named", () => {
  const tooMany = checkUploadPayload(Array.from({ length: MAX_PHOTOS + 1 }, () => 100 * 1024));
  assert.ok(!tooMany.ok);
  assert.match(tooMany.reason, new RegExp(`${MAX_PHOTOS} photos`), "say the actual limit");

  const oversize = checkUploadPayload([MAX_PHOTO_BYTES + 1]);
  assert.ok(!oversize.ok);
  assert.match(oversize.reason, /One photo is/, "singular when there is one");

  const twoOversize = checkUploadPayload([MAX_PHOTO_BYTES + 1, MAX_PHOTO_BYTES + 1]);
  assert.ok(!twoOversize.ok);
  assert.match(twoOversize.reason, /2 photos are/, "plural when there are more");
});

test("an empty selection is not an error here", () => {
  // "Choose at least one photo" is the actions' refusal and belongs there; the
  // budget answering the same question differently would produce two messages for
  // one situation.
  assert.equal(checkUploadPayload([]).ok, true);
});

/** The resize arithmetic. Wrong here means either huge uploads or broken images. */

test("a phone photo is scaled to the long edge, keeping its shape", () => {
  const landscape = fitWithinMaxEdge(4032, 3024);
  assert.equal(landscape.width, PHOTO_MAX_EDGE);
  assert.equal(landscape.height, Math.round(3024 * (PHOTO_MAX_EDGE / 4032)));

  // Portrait must scale on HEIGHT. Scaling always on width would leave a portrait
  // photo taller than the cap — the orientation a phone actually holds.
  const portrait = fitWithinMaxEdge(3024, 4032);
  assert.equal(portrait.height, PHOTO_MAX_EDGE);
  assert.ok(portrait.width < PHOTO_MAX_EDGE);
});

test("a small image is never scaled UP", () => {
  // Enlarging adds bytes and no detail. Returned unchanged so the caller can skip
  // re-encoding entirely and keep the original.
  assert.deepEqual(fitWithinMaxEdge(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithinMaxEdge(PHOTO_MAX_EDGE, 900), { width: PHOTO_MAX_EDGE, height: 900 });
});

test("an extreme aspect ratio cannot round a dimension to zero", () => {
  // A 0-width canvas cannot be drawn, and the upload would fail with nothing
  // useful to say. Floored at 1 instead.
  const sliver = fitWithinMaxEdge(20000, 3);
  assert.equal(sliver.width, PHOTO_MAX_EDGE);
  assert.ok(sliver.height >= 1, `height was ${sliver.height}`);
});

test("zero dimensions are returned untouched rather than dividing by zero", () => {
  assert.deepEqual(fitWithinMaxEdge(0, 0), { width: 0, height: 0 });
});

/** Wiring: the rules are useless if the upload paths do not apply them. */

test("every camera field resizes before submitting", () => {
  // A raw <input type="file" capture="environment"> posts the original bytes, which
  // is the defect. The field component is the only thing that shrinks them.
  for (const file of [
    "src/app/(app)/jobcards/page.tsx",
    "src/app/(app)/jobcards/[id]/page.tsx",
    "src/app/(app)/deliveries/page.tsx",
  ]) {
    const code = src(file);
    assert.doesNotMatch(
      code,
      /<input[^>]*capture="environment"/,
      `${file} still posts unresized camera files`,
    );
    assert.match(code, /<(?:PhotoUploadField|MobilePhotoCapture)/, `${file} must use the resizing field directly or through the mobile capture primitive`);
  }

  const mobileCapture = src("src/components/MobilePhotoCapture.tsx");
  assert.match(mobileCapture, /<PhotoUploadField/);
  assert.match(mobileCapture, /<SaveButton[^>]*w-full/);
});

test("both upload actions enforce the TOTAL payload, not only per-file", () => {
  for (const file of ["src/app/actions/jobcards.ts", "src/app/actions/fulfilment.ts"]) {
    const code = src(file);
    assert.match(code, /checkUploadPayload\(/, `${file} must check the total`);
    assert.match(code, /if \(!payload\.ok\) refuse\(payload\.reason\)/, `${file} must refuse with the reason`);
  }
});

test("the capture menu asks for the WRITE permission it leads to", () => {
  // Offering a view-only technician a camera button that can only end in a refusal
  // is not an authorization bug, but it is a promise the app cannot keep.
  const nav = src("src/components/MobileCompanionNav.tsx");
  assert.match(nav, /can\("jobcards\.manage"\) && packOn\("\/jobcards"\)/);
  assert.match(nav, /can\("deliveries\.manage"\) && packOn\("\/deliveries"\)/);
  assert.doesNotMatch(nav, /can\("deliveries\.view", "deliveries\.manage"\)/, "view is not enough to upload");
});

/**
 * THE SUBMIT RACE.
 *
 * Resizing on `change` alone was not enough, and review was right about why. On a
 * phone the decode of five camera photos takes a moment, and nothing stopped the
 * person tapping Upload during it:
 *
 *   select 5 photos → resize starts → user taps Upload
 *     → FORM SUBMITS THE ORIGINALS → resize finishes, too late
 *
 * `working` only changed a status line. It disabled no button and blocked no
 * submission, so the originals — tens of megabytes — went to a framework that
 * refuses anything over the declared limit, and the upload action never ran.
 *
 * The component now owns the submit boundary rather than decorating it.
 */

test("submission is intercepted until the files have been prepared", () => {
  const code = src("src/components/PhotoUploadField.tsx");
  assert.match(code, /form\.addEventListener\("submit", onSubmit, \{ capture: true \}\)/,
    "the boundary must be the submit event, not the change event");
  // Capture phase: a bubble-phase listener runs after React has already begun the
  // form action, which is too late to swap the files.
  assert.match(code, /\{ capture: true \}/);
  assert.match(code, /event\.preventDefault\(\)/);
  assert.match(code, /if \(preparedRef\.current\) return;/, "a prepared batch must pass straight through");
  assert.match(code, /form\.requestSubmit\(\)/, "and be resubmitted once ready");
});

test("an over-limit batch is not resubmitted", () => {
  // Re-submitting a payload the budget just refused would reproduce the exact
  // failure the check exists to prevent, and the reason is already on screen.
  const code = src("src/components/PhotoUploadField.tsx");
  assert.match(code, /if \(ok\) form\.requestSubmit\(\)/);
  const prepare = code.slice(code.indexOf("async function prepare("), code.indexOf("function onPick("));
  assert.match(prepare, /preparedRef\.current = false;\s*\n\s*return false;/,
    "a refused batch must stay unprepared so the next submit is stopped too");
});

test("a new selection is unprepared again", () => {
  // Otherwise picking new photos after a successful prepare would submit the new
  // originals under the old batch's clearance.
  const code = src("src/components/PhotoUploadField.tsx");
  const onPick = code.slice(code.indexOf("function onPick("));
  assert.match(onPick, /preparedRef\.current = false;/);
});

test("readiness is a ref, not state", () => {
  // The submit handler reads it DURING the event. A state value captured in a
  // closure can be a render behind, which is the race this exists to close.
  const code = src("src/components/PhotoUploadField.tsx");
  assert.match(code, /const preparedRef = useRef\(false\)/);
  assert.doesNotMatch(code, /const \[prepared, setPrepared\]/);
});

/**
 * THE SECOND RACE — two preparations, and the slower one wins.
 *
 * Reported in review after the submit boundary fixed the first one:
 *
 *   select A → prepare(A) starts
 *   select B → prepare(B) starts
 *   prepare(B) finishes → input = B
 *   prepare(A) finishes → input = A     ← the person chose B, A gets uploaded
 *
 * Both preparations were allowed to publish their results, so whichever decoded
 * LAST won regardless of which selection it belonged to. On job-card and delivery
 * evidence that is worse than an upload error: it is wrong, and it is silent.
 */

test("a superseded preparation discards its own result", () => {
  const code = src("src/components/PhotoUploadField.tsx");
  assert.match(code, /const selectionRef = useRef\(0\)/, "each selection needs an identity");
  assert.match(code, /const token = selectionRef\.current;/, "captured when the work starts");
  assert.match(
    code,
    /if \(token !== selectionRef\.current\) return false;/,
    "and checked before publishing — otherwise the older result overwrites the newer",
  );
});

test("the check happens AFTER the slow work, before the input is written", () => {
  // Checking before the decode would prove nothing: the whole point is that the
  // selection can change WHILE it runs.
  const code = src("src/components/PhotoUploadField.tsx");
  const prepare = code.slice(code.indexOf("async function prepare("), code.indexOf("function onPick("));
  const decode = prepare.indexOf("await Promise.all(picked.map(shrink))");
  const guard = prepare.indexOf("token !== selectionRef.current");
  const publish = prepare.indexOf("input.files = transfer.files");
  assert.ok(decode !== -1 && guard !== -1 && publish !== -1);
  assert.ok(decode < guard, "the guard must come after the decode");
  assert.ok(guard < publish, "and before the input is replaced");
});

test("picking new photos invalidates work already in flight", () => {
  const code = src("src/components/PhotoUploadField.tsx");
  const onPick = code.slice(code.indexOf("function onPick("));
  assert.match(onPick, /selectionRef\.current \+= 1;/, "a new selection takes the next token");
});

test("only the current preparation clears the working state", () => {
  // A superseded one finishing late would otherwise report "done" while the live
  // preparation is still decoding, and the submit guard would let it through.
  const code = src("src/components/PhotoUploadField.tsx");
  assert.match(code, /if \(token === selectionRef\.current\) setWorking\(false\)/);
});
