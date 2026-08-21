import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CHECKLIST_LIMITS,
  MIN_SKIP_REASON,
  TEMPLATE_INPUT,
  ENTRY_INPUT,
  RUN_INPUT,
  isComplete,
  outstanding,
  templateProblems,
  type EntryState,
} from "../src/lib/checklists/types";

/**
 * Guards for guided checklists.
 *
 * The suite is split the way lib/checklists is split, and for the same reason.
 * `types.ts` and `hosts.ts` are pure — no Prisma, no `server-only` — so the rules
 * that decide whether a handover is finished are EXERCISED here rather than
 * described. The action files construct a Prisma client at import time and cannot
 * be loaded by `node --test`, so what they are held to is a SOURCE CONTRACT: the
 * order of the guards, which is the only property that actually matters about
 * them.
 *
 * That split is not a compromise on the interesting half. Every one of these
 * actions is a POST endpoint reachable without the screen that renders the
 * button, and everything they receive comes off a phone that minted its own ids.
 * The three ways that goes wrong are: evidence attached to a record the caller
 * could not otherwise touch, a completed handover rewritten afterwards, and a run
 * signed off as finished with a photograph missing. There is a test below for
 * each.
 */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const RUNS_PATH = "src/app/actions/checklistRuns.ts";
const TEMPLATES_PATH = "src/app/actions/checklistTemplates.ts";
const STORE_PATH = "src/lib/checklists/store.ts";

/**
 * Source with its comments removed.
 *
 * Every ORDER assertion below runs against this. The comments in these files
 * quote the very calls being ordered — "before any `create`" — so matching
 * against the raw text would let a guard pass on the strength of a sentence
 * describing it.
 */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // The `[^:]` keeps a `https://` or a `foo://` from being read as a comment.
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Each exported server action, name → body (to the next export, or EOF). */
function exportedBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const parts = source.split(/\bexport async function /).slice(1);
  for (const part of parts) {
    const name = part.slice(0, part.indexOf("("));
    bodies.set(name.trim(), part);
  }
  return bodies;
}

/** Where the first row-changing Prisma call sits, or -1. */
function firstWriteAt(body: string): number {
  const match = /\b(?:basePrisma|tx)\.[A-Za-z]+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.exec(
    body,
  );
  return match ? match.index : -1;
}

/* ══ what "finished" means ══════════════════════════════════════════════ */

function entry(overrides: Partial<EntryState> = {}): EntryState {
  return {
    id: "entry-1",
    labelSnapshot: "Serial number",
    captureSnapshot: "photo",
    requiredSnapshot: true,
    minPhotosSnapshot: 1,
    status: "done",
    note: null,
    value: null,
    skipReason: null,
    photoCount: 1,
    ...overrides,
  };
}

test("a required photo step is outstanding until it has the photos it asked for", () => {
  const none = outstanding([entry({ photoCount: 0 })]);
  assert.equal(none.length, 1);
  assert.equal(none[0].label, "Serial number");
  assert.equal(none[0].reason, "needs 1 more photo");

  // The count is the SHORTFALL, not the requirement: "needs 2 more photos" after
  // one of three is the sentence that tells somebody what to go and do.
  const short = outstanding([entry({ minPhotosSnapshot: 3, photoCount: 1 })]);
  assert.equal(short.length, 1);
  assert.equal(short[0].reason, "needs 2 more photos");

  assert.equal(outstanding([entry({ minPhotosSnapshot: 3, photoCount: 3 })]).length, 0);
  // More than asked for is not a problem. A step that wants one photo of a
  // scratch and got four is finished.
  assert.equal(outstanding([entry({ minPhotosSnapshot: 1, photoCount: 4 })]).length, 0);
});

test("a required step may be skipped, but not silently", () => {
  for (const status of ["skipped", "na"] as const) {
    const bare = outstanding([entry({ status, photoCount: 0 })]);
    assert.equal(bare.length, 1, `${status} with no reason must be outstanding`);
    assert.equal(bare[0].reason, "needs a reason for skipping");

    // Too short is the case that matters. A skip reason of "x" is a skip reason
    // in the schema and no reason at all to the person reading the handover
    // afterwards.
    const terse = "x".repeat(MIN_SKIP_REASON - 1);
    assert.equal(
      outstanding([entry({ status, photoCount: 0, skipReason: terse })]).length,
      1,
      `${status} with a ${terse.length}-character reason must still be outstanding`,
    );
    // Whitespace is not a reason either.
    assert.equal(
      outstanding([entry({ status, photoCount: 0, skipReason: "      " })]).length,
      1,
      `${status} with a blank reason must still be outstanding`,
    );

    assert.equal(
      outstanding([entry({ status, photoCount: 0, skipReason: "not in the box" })]).length,
      0,
      `${status} with a real reason is accounted for`,
    );
  }
});

test("a photo_note step needs its note as well as its photo", () => {
  const missing = outstanding([entry({ captureSnapshot: "photo_note", photoCount: 1 })]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].reason, "needs a note");

  assert.equal(
    outstanding([entry({ captureSnapshot: "photo_note", photoCount: 1, note: "   " })]).length,
    1,
    "a whitespace note is not a note",
  );
  assert.equal(
    outstanding([entry({ captureSnapshot: "photo_note", photoCount: 1, note: "Scuffed on the left" })])
      .length,
    0,
  );

  // Both can be wrong at once, and both must be reported — telling somebody
  // about the photo, then about the note after they fix it, is two trips.
  const both = outstanding([entry({ captureSnapshot: "photo_note", photoCount: 0 })]);
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((item) => item.reason).sort(), ["needs 1 more photo", "needs a note"]);
});

test("a non-photo step marked done must carry its answer — except a boolean", () => {
  for (const capture of ["text", "number"] as const) {
    assert.equal(
      outstanding([entry({ captureSnapshot: capture, photoCount: 0 })]).length,
      1,
      `${capture} done with no value must be outstanding`,
    );
    assert.equal(
      outstanding([entry({ captureSnapshot: capture, photoCount: 0, value: "  " })]).length,
      1,
      `${capture} done with a blank value must be outstanding`,
    );
    assert.equal(
      outstanding([entry({ captureSnapshot: capture, photoCount: 0, value: "AB-123" })])[0],
      undefined,
    );
  }
  assert.equal(
    outstanding([entry({ captureSnapshot: "text", photoCount: 0 })])[0].reason,
    "needs an answer",
  );

  // `boolean` is exempt. An unticked box and an unanswered box look identical in
  // a value column, which is why the STATUS carries the meaning there — demanding
  // a value would make "no, the charger is not included" impossible to record.
  assert.equal(
    outstanding([entry({ captureSnapshot: "boolean", photoCount: 0, value: null })]).length,
    0,
  );
  assert.equal(
    outstanding([entry({ captureSnapshot: "boolean", photoCount: 0, value: "false" })]).length,
    0,
  );
  // And a boolean does not acquire a photo requirement from its snapshot.
  assert.equal(
    outstanding([entry({ captureSnapshot: "boolean", minPhotosSnapshot: 2, photoCount: 0 })]).length,
    0,
  );
});

test("a required step that nobody has touched says so", () => {
  const pending = outstanding([entry({ status: "pending", photoCount: 0 })]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, "not done yet");
});

test("an optional step is never outstanding, whatever state it is in", () => {
  const states: Array<Partial<EntryState>> = [
    { status: "pending", photoCount: 0 },
    { status: "done", photoCount: 0 },
    { status: "skipped", photoCount: 0, skipReason: null },
    { status: "na", photoCount: 0 },
    { status: "done", captureSnapshot: "photo_note", photoCount: 0, note: null },
    { status: "done", captureSnapshot: "text", photoCount: 0, value: null },
  ];
  for (const state of states) {
    assert.equal(
      outstanding([entry({ ...state, requiredSnapshot: false })]).length,
      0,
      `optional step in state ${JSON.stringify(state)} must never be outstanding`,
    );
  }
});

test("isComplete is exactly 'nothing outstanding'", () => {
  const finished = [entry(), entry({ id: "e2", captureSnapshot: "boolean", photoCount: 0 })];
  assert.equal(isComplete(finished), true);
  assert.equal(isComplete([...finished, entry({ id: "e3", photoCount: 0 })]), false);
  // An empty run is vacuously complete HERE, which is why completeChecklistRun
  // refuses one separately — see the source contract below.
  assert.equal(isComplete([]), true);
});

/* ══ what a template may say ════════════════════════════════════════════ */

function template(items: Array<Record<string, unknown>>) {
  return TEMPLATE_INPUT.parse({ host: "quote.delivery", name: "Handover", items });
}

test("a template cannot ask the same question twice", () => {
  const problems = templateProblems(
    template([{ label: "Charger" }, { label: " charger " }]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Two steps are both called/);
});

test("a step's photo bounds have to be possible, and match what it collects", () => {
  assert.match(
    templateProblems(template([{ label: "Panels", minPhotos: 4, maxPhotos: 2 }]))[0],
    /at least 4 photos but allows at most 2/,
  );
  assert.match(
    templateProblems(template([{ label: "Serial", required: true, minPhotos: 0 }]))[0],
    /required but asks for no photos/,
  );
  assert.match(
    templateProblems(template([{ label: "Odometer", capture: "number", minPhotos: 1 }]))[0],
    /does not collect photos, so it cannot require any/,
  );
  assert.deepEqual(
    templateProblems(
      template([
        { label: "Serial", capture: "photo", minPhotos: 2, maxPhotos: 3 },
        { label: "Odometer", capture: "number", minPhotos: 0, maxPhotos: 1 },
        { label: "Charger included", capture: "boolean", minPhotos: 0, maxPhotos: 1 },
      ]),
    ),
    [],
  );
});

test("the wire format demands the ids the device minted", () => {
  // Short ids are the failure this prevents: a client that sends "1", "2", "3"
  // collides with every other device the moment two runs sync.
  assert.equal(ENTRY_INPUT.safeParse({ id: "abc", labelSnapshot: "x", captureSnapshot: "photo" }).success, false);
  assert.equal(
    RUN_INPUT.safeParse({
      id: "run-00000001",
      templateId: "tpl-1",
      templateVersion: 1,
      hostType: "quote.delivery",
      hostId: "q1",
      startedAt: "2026-08-21T09:00:00.000Z",
      entries: [],
    }).success,
    true,
  );
  // A host this build does not have is refused at the schema, before anything
  // tries to resolve a permission for it.
  assert.equal(
    RUN_INPUT.safeParse({
      id: "run-00000001",
      templateId: "tpl-1",
      templateVersion: 1,
      hostType: "invoice.something",
      hostId: "q1",
      startedAt: "2026-08-21T09:00:00.000Z",
      entries: [],
    }).success,
    false,
  );
  // And a run cannot carry more answers than a template may have questions.
  const tooMany = Array.from({ length: CHECKLIST_LIMITS.itemsPerTemplate + 1 }, (_, i) => ({
    id: `entry-0000000${i}`,
    itemId: `item-${i}`,
  }));
  assert.equal(
    RUN_INPUT.safeParse({
      id: "run-00000001",
      templateId: "tpl-1",
      templateVersion: 1,
      hostType: "quote.delivery",
      hostId: "q1",
      startedAt: "2026-08-21T09:00:00.000Z",
      entries: tooMany,
    }).success,
    false,
  );
});

/* ══ the door, and the order every write goes through it ════════════════ */

test("every capture action resolves the workspace and authorises the host before it writes", () => {
  const bodies = exportedBodies(code(RUNS_PATH));
  assert.deepEqual(
    [...bodies.keys()].sort(),
    ["completeChecklistRun", "deleteChecklistPhoto", "registerChecklistPhoto", "syncChecklistRun"],
    "unexpected set of capture actions",
  );

  for (const [name, body] of bodies) {
    const tenantAt = body.indexOf("await actingTenantId()");
    const hostAt = body.indexOf("requireChecklistHostAccess(");
    const writeAt = firstWriteAt(body);

    assert.ok(tenantAt >= 0, `${name} must resolve the acting workspace itself`);
    assert.ok(hostAt >= 0, `${name} must go through requireChecklistHostAccess`);
    assert.ok(writeAt >= 0, `${name} must actually write something, or this guard proves nothing`);
    assert.ok(
      tenantAt < writeAt,
      `${name} must resolve the workspace before it changes a row`,
    );
    assert.ok(
      hostAt < writeAt,
      `${name} must authorise the host record before it changes a row — the host is the only thing standing between a checklist and a record the caller cannot otherwise touch`,
    );
  }
});

test("every configuration action gates on the settings permission before it writes", () => {
  const bodies = exportedBodies(code(TEMPLATES_PATH));
  assert.deepEqual(
    [...bodies.keys()].sort(),
    [
      "deleteChecklistTemplate",
      "reorderChecklistTemplates",
      "saveChecklistTemplate",
      "setChecklistTemplateActive",
    ],
    "unexpected set of configuration actions",
  );

  for (const [name, body] of bodies) {
    const gateAt = body.search(/await requireChecklist(Settings|Configurer)\(/);
    const tenantAt = body.indexOf("await actingTenantId()");
    const writeAt = firstWriteAt(body);
    assert.ok(gateAt >= 0, `${name} must gate on the checklist settings permission`);
    assert.ok(tenantAt >= 0, `${name} must resolve the acting workspace itself`);
    assert.ok(writeAt >= 0, `${name} must actually write something`);
    assert.ok(gateAt < writeAt, `${name} must be gated before it changes a row`);
    assert.ok(tenantAt < writeAt, `${name} must resolve the workspace before it changes a row`);
    // Configuring is not per-record, so there is no host RECORD to authorise —
    // but the host itself must still be one this person could use, or the
    // settings key would let somebody author the questions on a handover they
    // may not perform, in a module their workspace does not have.
    assert.ok(
      /requireUsableHost\(|requireChecklistConfigurer\(/.test(body),
      `${name} must check the host is usable by this person`,
    );
  }

  const source = code(TEMPLATES_PATH);
  assert.match(
    source,
    /async function requireChecklistSettings\(\): Promise<PermissionUser> \{\s*return requirePermission\(CONFIGURE_CHECKLISTS\);/,
    "the settings gate must be a real permission check",
  );
  assert.match(
    source,
    /requireUsableHost[\s\S]{0,600}canUseHost\(host, \{/,
    "the host gate must reuse canUseHost rather than re-deriving who may see what",
  );
});

test("the permission the configuration actions demand is a real key, not an invented one", () => {
  const chosen = /const CONFIGURE_CHECKLISTS: PermissionKey = "([^"]+)"/.exec(code(TEMPLATES_PATH));
  assert.ok(chosen, "the configuration key must be declared in one named place");
  // The catalogue in lib/permissions.ts is the only place a key exists. A key
  // that is not in it is grantable to nobody and would lock every non-owner out
  // of a screen the product offers them.
  assert.ok(
    new RegExp(`"${chosen[1]}"`).test(src("src/lib/permissions.ts")),
    `${chosen[1]} is not in the PERMISSIONS catalogue`,
  );
});

test("no checklist action accepts a workspace id", () => {
  for (const rel of [RUNS_PATH, TEMPLATES_PATH]) {
    const source = code(rel);
    const signatures = [...source.matchAll(/export async function (\w+)\(([\s\S]*?)\):\s*Promise</g)];
    assert.ok(signatures.length >= 4, `could not read the signatures in ${rel}`);
    for (const [, name, params] of signatures) {
      assert.ok(
        !/tenant/i.test(params),
        `${name} must not take a workspace id — a server action is a POST endpoint, and a tenantId parameter is an invitation to file one business's evidence under another`,
      );
    }
  }
  // The read path is held to the same rule, for the same reason: its arguments
  // ultimately come from a URL.
  const store = code(STORE_PATH);
  for (const [, params] of store.matchAll(/cache\(\s*async \(([^)]*)\)/g)) {
    assert.ok(!/tenant/i.test(params), "a store read must not take a workspace id");
  }
  assert.ok(
    store.split("actingTenantId()").length - 1 >= 4,
    "every store read must resolve the workspace itself",
  );
});

/* ══ a completed run is a record ════════════════════════════════════════ */

test("syncChecklistRun refuses to touch a run that has already been completed", () => {
  const body = exportedBodies(code(RUNS_PATH)).get("syncChecklistRun")!;
  const refusalAt = body.search(/if \(existing\?\.completedAt\)\s*\{\s*refuse\(/);
  assert.ok(
    refusalAt >= 0,
    "a late sync against a completed run must be refused, not applied — a handover somebody signed for cannot be rewritten by a phone coming out of a tunnel",
  );
  assert.ok(
    refusalAt < firstWriteAt(body),
    "the refusal must come before anything is written",
  );
  // The lookup that finds it must not be workspace-scoped, or an id held by
  // another workspace reads as "no such run" and the upsert tries to create it.
  assert.match(
    body,
    /checklistRun\.findUnique\(\{\s*where: \{ id: run\.id \}/,
    "the id holder must be resolved globally so a collision can be refused in a sentence",
  );
  assert.match(
    body,
    /existing\.tenantId !== tenantId/,
    "an id held by another workspace must be refused",
  );
  // And a re-sync must not be able to re-point a run at another record.
  assert.match(
    body,
    /existing\.hostType !== run\.hostType[\s\S]{0,200}existing\.hostId !== run\.hostId/,
    "an existing run must not be re-targeted at a different record",
  );
});

test("syncChecklistRun proves the template belongs here and fits this situation", () => {
  const body = exportedBodies(code(RUNS_PATH)).get("syncChecklistRun")!;
  assert.match(
    body,
    /checklistTemplate\.findFirst\(\{\s*where: \{ id: run\.templateId, tenantId \}/,
    "the template must be resolved within the acting workspace",
  );
  assert.match(
    body,
    /if \(template\.host !== run\.hostType\)/,
    "a run must not answer a list built for a different situation",
  );
  // The exact device-rendered revision is resolved server-side and stamped at
  // CREATE only. Re-reading today's template version would rewrite old work.
  assert.match(body, /revisions: \{[\s\S]*?where: \{ version: run\.templateVersion \}/, "the submitted revision must be resolved authoritatively");
  assert.match(body, /create: \{[\s\S]*?templateVersion: revision\.version/, "the authoritative revision must be stamped on create");
  for (const field of ["label", "description", "capture", "required", "minPhotos", "maxPhotos"] as const) {
    assert.match(
      body,
      new RegExp(`${field}Snapshot: item\\.${field}`),
      `${field} must come from the authoritative revision, not the device`,
    );
  }
  assert.match(body, /submittedItems\.length !== applicableIds\.size/);
  assert.match(body, /submittedItems\.some\(\(itemId\) => !applicableIds\.has\(itemId\)\)/);
  assert.ok(
    !/update: \{[\s\S]{0,200}templateVersion/.test(body),
    "the stamped revision must never be rewritten by a later sync",
  );
  // An entry id already held elsewhere must be refused, not adopted — upserting
  // one would drag another run's photographs onto this record.
  assert.match(
    body,
    /checklistEntry\.findMany\(\{\s*where: \{ id: \{ in: entryIds \}, NOT: \{ runId: run\.id, tenantId \} \}/,
    "entry ids held by another run or workspace must be detected",
  );
});

test("completeChecklistRun recomputes completeness from the database", () => {
  const body = exportedBodies(code(RUNS_PATH)).get("completeChecklistRun")!;
  // Signature first: there is nowhere for a client claim of completeness to
  // arrive, which is the strongest form this guard can take.
  assert.match(
    code(RUNS_PATH),
    /export async function completeChecklistRun\(runId: string\): Promise<ActionResult>/,
    "completeChecklistRun must take only the run id",
  );
  assert.match(
    body,
    /_count: \{ select: \{ photos: true \} \}/,
    "the photo counts must be counted rows, not a number the device reported",
  );
  const readAt = body.indexOf("checklistEntry.findMany");
  const judgeAt = body.indexOf("outstanding(");
  const writeAt = firstWriteAt(body);
  assert.ok(readAt >= 0 && judgeAt > readAt, "the run must be read before it is judged");
  assert.ok(judgeAt < writeAt, "the run must be judged before it is completed");
  assert.match(
    body,
    /outstanding\(entries\.map\(\(entry\) => entryState\(entry, entry\._count\.photos\)\)\)/,
    "completeness must be computed from the stored entries and the real photo counts",
  );
  assert.match(body, /if \(missing\.length > 0\) refuse\(/, "an unfinished run must be refused");
  // An empty run satisfies every rule vacuously. Without this it would be a way
  // to produce a signed-off handover with nothing in it.
  assert.match(body, /entries\.length === 0/, "an empty run must not count as complete");
  // The completion itself is guarded, so two people tapping Complete produce one
  // completion with one name on it.
  assert.match(
    body,
    /checklistRun\.updateMany\(\{\s*where: \{ id: run\.id, tenantId, completedAt: null \}/,
    "the completion must re-assert that the run is still open at the moment it is written",
  );
});

/* ══ a photo is only what the store says it is ══════════════════════════ */

test("registerChecklistPhoto verifies the blob before it records anything", () => {
  const body = exportedBodies(code(RUNS_PATH)).get("registerChecklistPhoto")!;

  const ownedAt = body.indexOf("await assertOwnedBlob(url, entry.tenantId)");
  const typeAt = body.indexOf('blob.contentType.startsWith("image/")');
  const sizeAt = body.indexOf("blob.size > MAX_PHOTO_BYTES");
  const prefixAt = body.indexOf(
    "blob.pathname.startsWith(`uploads/${entry.tenantId}/checklist/${entry.id}/`)",
  );
  const writeAt = firstWriteAt(body);

  assert.ok(ownedAt >= 0, "the object must be proved to be in our store, under this workspace");
  assert.ok(typeAt > ownedAt, "the content type must come from the store, not the caller");
  assert.ok(sizeAt > ownedAt, "the size must come from the store, not the caller");
  assert.ok(
    prefixAt > ownedAt,
    "the pathname must sit under this ENTRY's own upload prefix — it is what stops a photo captured for one step being filed against another",
  );
  assert.match(body, /blob\.size <= 0/, "a zero-byte object is not a photograph");
  for (const [what, at] of [["ownership", ownedAt], ["content type", typeAt], ["size", sizeAt], ["pathname", prefixAt]] as const) {
    assert.ok(at < writeAt, `the ${what} check must run before the row is written`);
  }

  // Photos are APPENDED. Unlike the inspection finalizer there is no previous
  // blob to clean up, and deleting one here would destroy a photograph somebody
  // deliberately took as a second angle.
  assert.ok(
    !/deleteFile\(/.test(body),
    "registerChecklistPhoto must not delete anything — removal is deleteChecklistPhoto's job",
  );
  // The cap is against rows that exist, and a completed run accepts nothing.
  assert.match(body, /checklistPhoto\.count\(\{ where: \{ tenantId, entryId: entry\.id \} \}\)/, "the photo cap must be enforced against stored rows");
  assert.match(body, /entryMaxPhotos\(entry\.maxPhotosSnapshot, entry\.minPhotosSnapshot\)/, "the immutable upper snapshot must set the cap");
  assert.match(body, /FOR UPDATE/, "photo registration must share the run finality lock");
  assert.match(body, /locked\.completedAt/, "a completed run must not gain evidence");
});

test("deleteChecklistPhoto removes the row first and then the object", () => {
  const body = exportedBodies(code(RUNS_PATH)).get("deleteChecklistPhoto")!;
  const rowAt = body.indexOf("checklistPhoto.deleteMany(");
  const blobAt = body.indexOf("deleteFile(photo.url)");
  assert.ok(rowAt >= 0 && blobAt > rowAt, "the row must go before the object");
  assert.match(
    body,
    /deleteFile\(photo\.url\)\.catch\(async \(error\) => \{\s*await logError\(/,
    "a failed object delete must be logged, not thrown — the person has already had what they asked for",
  );
  assert.match(body, /FOR UPDATE/, "photo deletion must share the run finality lock");
  assert.match(body, /locked\.completedAt/, "a completed run's photos are a record");
});

/* ══ the read path reads ════════════════════════════════════════════════ */

test("the store never writes, and every read is memoised and workspace-scoped", () => {
  const store = code(STORE_PATH);
  assert.ok(
    firstWriteAt(store) === -1,
    "lib/checklists/store.ts is the read path — a write here would be a second, ungated way to change a run",
  );
  for (const name of ["templatesForHost", "templateById", "runsForHost", "runById"]) {
    assert.ok(
      new RegExp(`export const ${name} = cache\\(`).test(store),
      `${name} must be memoised per request`,
    );
  }
  // Reading a run is a disclosure of somebody's photographs, so it goes through
  // the same door the writes do.
  assert.match(store, /runsForHost = cache\([\s\S]{0,400}await requireChecklistHostAccess\(/);
  assert.match(store, /runById = cache\([\s\S]{0,600}await requireChecklistHostAccess\(/);
  // And the run is resolved within the workspace BEFORE its host is authorised,
  // or the caller would be naming the host themselves.
  const runById = store.slice(store.indexOf("export const runById"));
  assert.ok(
    runById.indexOf("checklistRun.findFirst") < runById.indexOf("requireChecklistHostAccess"),
    "the run must be resolved before the host it names is authorised",
  );
  // Deactivated lists are not offered by default.
  assert.match(
    store,
    /includeInactive \? \{\} : \{ active: true \}/,
    "the picker must not be offered a list somebody deactivated",
  );
});

/* ══ one definition of "if" ═════════════════════════════════════════════ */

test("a step's visibility rule is parsed by the shared condition grammar", () => {
  const source = code(TEMPLATES_PATH);
  assert.match(
    source,
    /import \{ SECTION \} from "@\/lib\/dashboard\/config"/,
    "the condition schema must come from the dashboards' own module",
  );
  assert.match(source, /const VISIBILITY = SECTION\.shape\.visibility;/);
  assert.match(source, /VISIBILITY\.safeParse\(item\.visibility\)/);
  assert.match(source, /parsed\.data \?\? \[\]\)\.some\(isSecurityRelevant\)/, "screen-only rules must not be accepted by a server-validated checklist");
  // A second grammar is the drift this prevents. If any of these appear here,
  // somebody has started writing their own "if".
  for (const token of ['z.literal("and")', 'z.literal("or")', '"greater_or_equal"', 'kind: z.literal(']) {
    assert.ok(
      !source.includes(token),
      `checklistTemplates.ts must not restate the condition grammar (found ${token})`,
    );
  }
});

test("the template version moves when the questions move, and not otherwise", () => {
  const source = code(TEMPLATES_PATH);
  const fn = source.slice(source.indexOf("function itemsChanged"));
  for (const field of ["label", "capture", "required", "minPhotos", "maxPhotos"]) {
    assert.ok(
      new RegExp(`prior\\.${field} !== item\\.${field}`).test(fn),
      `a change to ${field} must produce a new revision — a run stamps this version to say which list it answered`,
    );
  }
  assert.match(fn, /prior\.description/);
  assert.match(fn, /prior\.sortOrder/);
  assert.match(fn, /prior\.visibility/);
  assert.match(fn, /if \(!prior\) return true;/, "a step this template does not own is a new step");
  assert.match(fn, /kept\.size !== existing\.length/, "a removed step must produce a new revision");
  // Renaming the TEMPLATE is not a new revision. Bumping for it would scatter a
  // workspace's runs across a dozen revisions that are all the same list.
  const save = exportedBodies(source).get("saveChecklistTemplate")!;
  assert.match(save, /const bump = itemsChanged\(existing\.items, template\.items\);/);
  assert.match(save, /\.\.\.\(bump \? \{ version: existing\.version \+ 1 \} : \{\}\)/);
});

test("a template that has been used cannot be deleted, and says what to do instead", () => {
  const body = exportedBodies(code(TEMPLATES_PATH)).get("deleteChecklistTemplate")!;
  const countAt = body.indexOf("checklistRun.count(");
  const deleteAt = body.indexOf("checklistTemplate.deleteMany(");
  assert.ok(countAt >= 0 && countAt < deleteAt, "the runs must be counted before the delete is attempted");
  assert.match(
    body,
    /deactivate it instead/,
    "the refusal must name the thing the person actually wants; the RESTRICT foreign key alone would reach them as a reference number",
  );
  // Re-asserted at the moment of the delete: the count is a moment old, and a
  // run started in between must survive.
  assert.match(body, /where: \{ id: template\.id, tenantId, runs: \{ none: \{\} \} \}/);
});

test("saving a template never adopts a step id it does not own", () => {
  const body = exportedBodies(code(TEMPLATES_PATH)).get("saveChecklistTemplate")!;
  assert.match(
    body,
    /const known = new Set\(existing\.items\.map\(\(item\) => item\.id\)\);/,
    "the ids this template owns must be established from the database",
  );
  assert.match(
    body,
    /if \(item\.id && known\.has\(item\.id\)\)/,
    "only a step this template owns may be updated in place",
  );
  assert.match(
    body,
    /where: \{ id: item\.id, templateId: existing\.id, tenantId \}/,
    "the update must name the template and the workspace, not the id alone",
  );
  assert.match(
    body,
    /if \(existing\.host !== template\.host\)/,
    "a list must not be moved to a different situation once runs have answered it",
  );
});
