import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("lead and contact capture use the same section, field, hero and footer primitives", () => {
  for (const file of ["LeadForm.tsx", "ContactForm.tsx"]) {
    const form = source("src", "components", file);
    assert.match(form, /CaptureField as Field/);
    assert.match(form, /CaptureSection as FormSection/);
    assert.match(form, /<CaptureHero/);
    assert.match(form, /<CaptureFooter variant=\{variant\}/);
    assert.doesNotMatch(form, /function FormSection\(/);
    assert.doesNotMatch(form, /function Field\(/);
  }
});

test("mobile operational photo capture has one prominent, gallery-ready pattern", () => {
  const component = source("src", "components", "DirectPhotoUploader.tsx");
  const jobcards = source("src", "app", "(app)", "jobcards", "page.tsx");
  const deliveries = source("src", "app", "(app)", "deliveries", "page.tsx");

  assert.match(component, /type="file"/);
  assert.match(component, /accept="image\/\*"/);
  assert.match(jobcards, /<DirectPhotoUploader[^>]*label="Add condition photos"/);
  assert.match(deliveries, /<DirectPhotoUploader[^>]*label="Add handover photos"/);

  /*
   * The upload URL moved to lib/photoTransport.ts when the guided checklist
   * runner became a second thing that sends photos.
   *
   * The assertion follows it rather than being deleted, and it is now stronger
   * than it was: the endpoint must appear in the shared transport, and must NOT
   * appear in either sender. What this guard is really protecting is that there
   * is ONE client-side sender — the blob pathname a caller builds has to match
   * the prefix `/api/photos/upload` checks before it will sign anything, so a
   * second hand-rolled copy of that string is how one screen silently loses the
   * ability to upload while the other keeps working.
   */
  const transport = source("src", "lib", "photoTransport.ts");
  assert.match(transport, /handleUploadUrl: "\/api\/photos\/upload"/);
  assert.doesNotMatch(component, /handleUploadUrl:/, "the uploader must not hold its own endpoint");
  const runner = source("src", "components", "checklists", "ChecklistRunner.tsx");
  assert.doesNotMatch(runner, /handleUploadUrl:/, "the checklist runner must not hold its own endpoint");
});

test("the mobile capture sheet prioritises on-site work before record creation", () => {
  const nav = source("src", "components", "MobileCompanionNav.tsx");

  assert.ok(nav.indexOf("On-site work") < nav.indexOf("Quick records"));
  assert.ok(nav.indexOf("Book test drive") < nav.indexOf("captures.map"));
  assert.ok(nav.indexOf("Job card photos") < nav.indexOf("captures.map"));
  assert.ok(nav.indexOf("Delivery photos") < nav.indexOf("captures.map"));
  assert.doesNotMatch(nav, /rounded-t-3xl|rounded-2xl border border-border bg-card p-4/);
});
