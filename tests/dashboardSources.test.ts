import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OPERATORS_FOR_TYPE,
  PERIODS,
  SOURCES,
  canUseField,
  canUseSource,
  fieldOf,
  isPeriodId,
  isSourceId,
  operatorsFor,
  sourceById,
  usableFields,
  usableSources,
  type FieldType,
  type SourceAccess,
  type SourceDef,
  type SourceField,
} from "../src/lib/dashboard/sources";
import { FILTER, normaliseHref } from "../src/lib/dashboard/config";

/**
 * Guards for the card builder's ALLOWLIST.
 *
 * Nothing in sources.ts is derived from the schema — every source and every field
 * is written out by hand, precisely so that a saved config cannot name a column
 * nobody chose to expose. That hand-written-ness is also the risk: the file can
 * drift from the database, and from the rules its own doc comments state. The
 * three things worth proving are the three ways that drift hurts — a path that
 * names a column this app does not have (a query that throws at render), a
 * composite field pretending it can answer a filter (a card that renders and is
 * wrong), and a permission gate that lets a viewer reach a column the record
 * pages would have kept from them.
 */

const root = path.join(__dirname, "..");
const SCHEMA = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

/** Which Prisma model each source reads from. Stated here, checked below. */
const ROOT_MODEL: Record<string, string> = {
  leads: "Lead",
  quotes: "Quote",
  activities: "Activity",
  contacts: "Contact",
  jobcards: "JobCard",
  vehicles: "Vehicle",
};

/**
 * model name → (field name → declared type token).
 *
 * Enough of a Prisma parse to answer "does this model have this column, and if
 * it is a relation, to what". Comment lines, block attributes and modifiers are
 * skipped; everything else is `name Type` at the head of a line.
 */
function parseSchema(text: string): Map<string, Map<string, string>> {
  const models = new Map<string, Map<string, string>>();
  for (const block of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, string>();
    for (const line of block[2].split("\n")) {
      const m = /^\s{2,}(\w+)\s+(\w+)/.exec(line);
      if (m) fields.set(m[1], m[2]);
    }
    models.set(block[1], fields);
  }
  return models;
}

const MODELS = parseSchema(SCHEMA);

/** Resolve a dotted source path against the schema; null if any hop is missing. */
function resolvePath(model: string, dotted: string): string | null {
  const parts = dotted.split(".");
  let current = model;
  for (let i = 0; i < parts.length; i += 1) {
    const type = MODELS.get(current)?.get(parts[i]);
    if (!type) return null;
    if (i === parts.length - 1) return type;
    if (!MODELS.has(type)) return null; // a scalar cannot be hopped through
    current = type;
  }
  return null;
}

const everyField = (): Array<{ source: SourceDef; field: SourceField }> =>
  SOURCES.flatMap((source) => source.fields.map((field) => ({ source, field })));

function access(permissions: string[], modules: string[] = ["core", "automotive"]): SourceAccess {
  return { permissions: new Set(permissions), modules: new Set(modules) };
}

const EVERY_PERMISSION = [...new Set(SOURCES.flatMap((s) => [...s.permissions] as string[]))];

/* ── the catalogue is internally coherent ─────────────────────────── */

test("source ids are unique and every lookup helper agrees with the list", () => {
  const ids = SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "two sources share an id, so one is unreachable");
  for (const source of SOURCES) {
    assert.equal(sourceById(source.id), source, "sourceById must return the very same object");
    assert.ok(isSourceId(source.id));
  }
  assert.equal(sourceById("payroll"), undefined);
  assert.equal(isSourceId("payroll"), false);
  assert.equal(isSourceId(undefined), false, "a missing source in a config must not narrow to SourceId");
});

test("field keys are unique within their source", () => {
  // A key is what a saved config stores. Two fields sharing one means `fieldOf`
  // silently answers with whichever came first, so a card configured against the
  // second one quietly queries the first.
  for (const source of SOURCES) {
    const keys = source.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `duplicate field key in ${source.id}`);
    for (const key of keys) assert.ok(fieldOf(source, key), `fieldOf failed for ${source.id}.${key}`);
    assert.equal(fieldOf(source, "not-a-field"), undefined);
  }
});

test("every source has a non-empty label, noun, permission list and field list", () => {
  for (const source of SOURCES) {
    assert.ok(source.label.length > 0, `${source.id} needs a label`);
    assert.ok(source.noun.length > 0, `${source.id} needs a plural noun for empty states`);
    assert.ok(source.fields.length > 0, `${source.id} has no fields, so nothing can be built on it`);
    assert.ok(source.permissions.length > 0, `${source.id} would be open to every signed-in user`);
  }
});

/* ── the catalogue matches the database ───────────────────────────── */

test("the schema parse found the models these sources actually read", () => {
  // A guard on the guard. If the parse below silently returned nothing, every
  // path check would pass vacuously and the whole cross-check would be theatre.
  assert.ok(MODELS.size > 20, "the schema parse produced implausibly few models");
  for (const source of SOURCES) {
    const model = ROOT_MODEL[source.id];
    assert.ok(model, `no root model recorded for source ${source.id}`);
    assert.ok(MODELS.get(model)?.size, `model ${model} was not found in prisma/schema.prisma`);
  }
});

test("every field path names a real column, through real relations", () => {
  // The failure this catches is a rename in schema.prisma that nobody carried
  // across: the field stays in the picker, the card saves, and the query throws
  // at render on the one page nobody can route around.
  for (const { source, field } of everyField()) {
    const model = ROOT_MODEL[source.id];
    assert.ok(
      resolvePath(model, field.path),
      `${source.id}.${field.key} maps to "${field.path}", which is not a column of ${model}`,
    );
    for (const extra of field.paths ?? []) {
      assert.ok(
        resolvePath(model, extra),
        `${source.id}.${field.key} joins "${extra}", which is not a column of ${model}`,
      );
    }
  }
});

test("owner-scoped sources name a real ownership column", () => {
  // `scope: { by: "owner" }` is the row-level security for a source with no
  // accessible-id helper. A column name that does not exist would make the
  // narrowing a no-op or a crash — and a no-op here is every user seeing every
  // row.
  for (const source of SOURCES) {
    if (source.scope.by !== "owner") continue;
    assert.ok(
      resolvePath(ROOT_MODEL[source.id], source.scope.field),
      `${source.id} scopes on "${source.scope.field}", which is not a column of ${ROOT_MODEL[source.id]}`,
    );
  }
});

test("no field path hops through more than one relation", () => {
  // One dot, one join. Two hops would mean a query whose cost and whose row
  // scoping both depend on a table the source never declared, and the compiler
  // has no way to apply the second table's own visibility rules.
  for (const { source, field } of everyField()) {
    for (const p of [field.path, ...(field.paths ?? [])]) {
      assert.ok(
        p.split(".").length <= 2,
        `${source.id}.${field.key} reaches "${p}", which is more than one relation hop`,
      );
    }
  }
});

test("labels are human prose, not column names", () => {
  // A label leaking a raw column ("assignedToId", "contact.firstName") is a sign
  // a field was pasted in from the schema rather than chosen, and it is what a
  // user sees in the picker.
  for (const { source, field } of everyField()) {
    assert.ok(field.label.length > 0, `${source.id}.${field.key} has no label`);
    assert.ok(!field.label.includes("."), `${source.id}.${field.key} label looks like a path`);
    assert.ok(!/Id$/.test(field.label), `${source.id}.${field.key} label looks like a foreign key`);
    assert.equal(field.label, field.label.trim());
  }
});

/* ── defaults must be usable, not just present ────────────────────── */

test("every defaultColumns entry names a real field of its own source", () => {
  // These are what a NEW list card starts with. An unknown key here means every
  // card anyone creates fails validation the moment they try to save it.
  for (const source of SOURCES) {
    assert.ok(source.defaultColumns.length > 0, `${source.id} offers no starting columns`);
    for (const key of source.defaultColumns) {
      assert.ok(fieldOf(source, key), `${source.id} starts with column "${key}", which it has no field for`);
    }
  }
});

test("every defaultSort names a real field that is actually sortable", () => {
  // The sort applied when a config names none. Pointing it at a composite or a
  // relation hop marked `sortable: false` would make every default card fail the
  // very rule cardProblems enforces on user-chosen sorts.
  for (const source of SOURCES) {
    const field = fieldOf(source, source.defaultSort.field);
    assert.ok(field, `${source.id} sorts by "${source.defaultSort.field}", which is not one of its fields`);
    assert.notEqual(
      field.sortable,
      false,
      `${source.id} sorts by ${field.key}, which is declared sortable: false`,
    );
    assert.ok(["asc", "desc"].includes(source.defaultSort.dir));
  }
});

test("every dateField names a real date field of its own source", () => {
  // This is what a relative period ("last 30 days") filters on. A non-date here
  // would compare a date range against a string column.
  for (const source of SOURCES) {
    const field = fieldOf(source, source.dateField);
    assert.ok(field, `${source.id} filters periods on "${source.dateField}", which is not one of its fields`);
    assert.equal(field.type, "date", `${source.id}.${field.key} is the period field but is not a date`);
  }
});

test("every source href is an internal path the button guard would accept", () => {
  // Row links share the phishing guard the button card uses. Anything that could
  // navigate off-app would do so from inside the product's own chrome.
  for (const source of SOURCES) {
    assert.equal(
      normaliseHref(source.href),
      source.href,
      `${source.id} links to "${source.href}", which is not an internal path`,
    );
  }
});

/* ── the composite-field invariant ────────────────────────────────── */

test("a composite field is never filterable, sortable or groupable", () => {
  // THE invariant documented on SourceField.paths, and the one most worth
  // holding. A composite is several columns joined into one displayed value, so
  // "surname contains 'du'" and "company contains 'du'" are different questions
  // and the joined value cannot answer either honestly. A composite that slipped
  // through as filterable would produce a card that renders, returns rows, and
  // is answering a question nobody asked.
  const composites = everyField().filter(({ field }) => field.paths && field.paths.length > 0);
  assert.ok(composites.length > 0, "there should be composite fields, or this test proves nothing");
  for (const { source, field } of composites) {
    assert.equal(field.filterable, false, `${source.id}.${field.key} joins columns but is filterable`);
    assert.equal(field.sortable, false, `${source.id}.${field.key} joins columns but is sortable`);
    assert.notEqual(field.groupable, true, `${source.id}.${field.key} joins columns but is groupable`);
  }
});

test("a composite's extra paths sit under the same relation as its primary path", () => {
  // The renderer joins the parts of ONE value. Parts reached through different
  // relations would be a row from two records glued together — "Jane" from the
  // contact and a company from somewhere else.
  for (const { source, field } of everyField()) {
    if (!field.paths?.length) continue;
    const prefix = field.path.includes(".") ? field.path.split(".")[0] : "";
    for (const extra of field.paths) {
      const extraPrefix = extra.includes(".") ? extra.split(".")[0] : "";
      assert.equal(
        extraPrefix,
        prefix,
        `${source.id}.${field.key} joins "${extra}" from a different record than "${field.path}"`,
      );
    }
  }
});

/* ── groupable and aggregatable mean what they say ────────────────── */

test("a free-text name is never groupable", () => {
  // Grouping by a name or a title gives one bar per row, which is not a chart —
  // it is a table drawn badly, and on a big source it is a chart with thousands
  // of categories that takes the page down rendering.
  const NAME_LIKE = /(^name$|Name$|^title$|^summary$|^description$)/;
  for (const { source, field } of everyField()) {
    if (field.type !== "text" || !NAME_LIKE.test(field.key)) continue;
    assert.notEqual(
      field.groupable,
      true,
      `${source.id}.${field.key} is a free-text name and must not be offered as a chart grouping`,
    );
  }
  // Control: low-cardinality text IS groupable, so the rule above is about names
  // rather than about text being excluded wholesale.
  assert.equal(fieldOf(sourceById("contacts")!, "city")!.groupable, true);
});

test("aggregatable is only ever true for a number or money field", () => {
  // Summing a date or a status is meaningless; the metric would either throw in
  // the compiler or produce a number that looks like an answer.
  for (const { source, field } of everyField()) {
    if (field.aggregatable !== true) continue;
    assert.ok(
      field.type === "number" || field.type === "money",
      `${source.id}.${field.key} is aggregatable but is a ${field.type}`,
    );
  }
  // And at least one exists, or the loop above is vacuous.
  assert.ok(everyField().some(({ field }) => field.aggregatable === true));
});

test("an enum field carries the options the editor's picker needs", () => {
  // `enum` promises a closed set. One with no options gives a picker with nothing
  // in it, and the user cannot build the filter at all.
  for (const { source, field } of everyField()) {
    if (field.type !== "enum") continue;
    assert.ok(field.options?.length, `${source.id}.${field.key} is an enum with no options`);
    const values = field.options!.map((o) => o.value);
    assert.equal(new Set(values).size, values.length, `${source.id}.${field.key} has duplicate option values`);
    for (const option of field.options!) assert.ok(option.label.length > 0, "every option needs a label");
  }
});

/* ── the two gates are independent and both must pass ─────────────── */

test("the module gate and the permission gate are independent, and both are required", () => {
  // Module state is a TENANT entitlement no role overrides; permission is WHO.
  // Passing one is not passing the other, and a source built on a switched-off
  // module would let a user query a feature the tenant is not entitled to.
  const jobcards = sourceById("jobcards")!;
  assert.equal(jobcards.module, "automotive", "the fixture depends on this source being module-gated");
  assert.equal(
    canUseSource(jobcards, access(["jobcards.view_all"], ["core"])),
    false,
    "permission alone must not open a source whose module is off",
  );
  assert.equal(
    canUseSource(jobcards, access([], ["core", "automotive"])),
    false,
    "the module alone must not open a source the viewer has no permission for",
  );
  assert.equal(
    canUseSource(jobcards, access(["jobcards.view_all"], ["core", "automotive"])),
    true,
    "both gates passing must open it, or the test above proves nothing",
  );
  // A source with no module declared is not module-gated at all.
  const leads = sourceById("leads")!;
  assert.equal(leads.module, undefined);
  assert.equal(canUseSource(leads, access(["leads.view_owned"], [])), true);
});

test("any one of a source's permissions grants it", () => {
  const leads = sourceById("leads")!;
  assert.equal(canUseSource(leads, access(["leads.view_all"])), true);
  assert.equal(canUseSource(leads, access(["leads.view_owned"])), true, "view_owned must also grant it");
  assert.equal(canUseSource(leads, access(["quotes.view_all"])), false, "another source's key must not");
  assert.equal(canUseSource(leads, access([])), false);
});

test("a source declaring no permissions is refused, not treated as open", () => {
  // Open-by-omission is the failure mode this explicit check exists for: a future
  // source added without a permission list would otherwise be readable by every
  // signed-in user, and nothing about the code would look wrong.
  const permissionless = { ...sourceById("leads")!, permissions: [] } as unknown as SourceDef;
  assert.equal(
    canUseSource(permissionless, access(EVERY_PERMISSION)),
    false,
    "an empty permission list must close a source, not open it",
  );
  // And no shipped source is in that state.
  for (const source of SOURCES) {
    assert.ok(source.permissions.length > 0, `${source.id} ships with no permissions`);
  }
});

test("usableSources offers exactly the sources canUseSource admits", () => {
  for (const key of EVERY_PERMISSION) {
    for (const modules of [["core"], ["core", "automotive"]]) {
      const viewer = access([key], modules);
      assert.deepEqual(
        usableSources(viewer).map((s) => s.id),
        SOURCES.filter((s) => canUseSource(s, viewer)).map((s) => s.id),
        `the source dropdown disagrees with the gate for ${key} / ${modules.join("+")}`,
      );
    }
  }
  assert.deepEqual(usableSources(access([])), [], "a viewer with no permissions is offered nothing");
});

/* ── field-level permission ───────────────────────────────────────── */

test("a viewer without leads.view_all is not offered the lead value field", () => {
  // The leak: someone who runs the diary can legitimately see that a lead exists
  // and who owns it. `value` is what the deal is WORTH. Without this gate, a rep
  // holding only leads.view_owned could build a stat card summing the whole
  // team's pipeline — reading, in aggregate, the exact figure the record pages
  // keep from them.
  const leads = sourceById("leads")!;
  const value = fieldOf(leads, "value")!;
  assert.equal(value.permission, "leads.view_all", "the fixture depends on this field being gated");

  const owned = access(["leads.view_owned"]);
  assert.equal(canUseField(value, owned), false, "a viewer without leads.view_all must not get `value`");
  assert.ok(
    !usableFields(leads, owned).some((f) => f.key === "value"),
    "the field picker must not offer a field the viewer is not trusted with",
  );
  // Everything ungated is still offered, so the filter is field-level rather
  // than a blanket refusal of the source.
  assert.ok(usableFields(leads, owned).some((f) => f.key === "name"));

  // Control: holding the key brings it back.
  const all = access(["leads.view_all"]);
  assert.equal(canUseField(value, all), true);
  assert.ok(usableFields(leads, all).some((f) => f.key === "value"));
});

test("an ungated field is available to anyone who reached the source at all", () => {
  for (const { field } of everyField()) {
    if (field.permission) continue;
    assert.equal(canUseField(field, access([])), true, "a field with no extra gate must not need one");
  }
});

test("usableFields is exactly the fields canUseField admits, in declaration order", () => {
  for (const source of SOURCES) {
    for (const keys of [[], ["leads.view_all"], EVERY_PERMISSION]) {
      const viewer = access(keys);
      assert.deepEqual(
        usableFields(source, viewer).map((f) => f.key),
        source.fields.filter((f) => canUseField(f, viewer)).map((f) => f.key),
        `${source.id} field picker disagrees with the gate`,
      );
    }
  }
});

/* ── operators ────────────────────────────────────────────────────── */

test("every field type has a non-empty operator set and every field resolves one", () => {
  // A type with no operators would put a field in the picker that no filter can
  // be written against — it looks available and silently is not.
  for (const [type, operators] of Object.entries(OPERATORS_FOR_TYPE)) {
    assert.ok(operators.length > 0, `field type ${type} offers no operators`);
    assert.equal(new Set(operators).size, operators.length, `${type} lists an operator twice`);
  }
  for (const { source, field } of everyField()) {
    assert.ok(operatorsFor(field).length > 0, `${source.id}.${field.key} has no usable operators`);
  }
  // Every field type in the union must be covered, not just the ones in use.
  const used = new Set(everyField().map(({ field }) => field.type));
  for (const type of used) assert.ok(OPERATORS_FOR_TYPE[type], `no operator set for ${type}`);
});

test("every offered operator is one the saved-filter schema will actually accept", () => {
  // The two vocabularies live in different files. If the editor offers an
  // operator the config schema rejects, the card cannot be saved; if it offers
  // one the schema accepts but the evaluator does not know, `compare` fails
  // closed and the card silently never matches.
  for (const [type, operators] of Object.entries(OPERATORS_FOR_TYPE)) {
    for (const operator of operators) {
      assert.equal(
        FILTER.safeParse({ field: "x", operator }).success,
        true,
        `${type} offers "${operator}", which a saved filter cannot hold`,
      );
    }
  }
});

test("`contains` is offered for text but withheld from enum", () => {
  // A closed set is chosen from a dropdown, so substring-matching the value the
  // user picked only produces surprises — "open" matching "reopened", or a
  // status filter that quietly widens itself.
  assert.ok(OPERATORS_FOR_TYPE.text.includes("contains"), "free text is what contains is for");
  assert.ok(!OPERATORS_FOR_TYPE.enum.includes("contains"), "an enum must be matched exactly");
  assert.ok(!OPERATORS_FOR_TYPE.enum.includes("not_contains"));
  assert.ok(OPERATORS_FOR_TYPE.enum.includes("in"), "an enum gets `in` instead, which is the honest version");
  // Numbers and dates get ordering rather than substrings.
  for (const type of ["number", "money", "date"] as FieldType[]) {
    assert.ok(!OPERATORS_FOR_TYPE[type].includes("contains"), `${type} must not offer substring matching`);
    assert.ok(OPERATORS_FOR_TYPE[type].includes("greater_than"), `${type} must be orderable`);
  }
});

/* ── periods ──────────────────────────────────────────────────────── */

test("every period is relative, uniquely identified and labelled", () => {
  // A card pinned to a fixed date range is silently wrong from the next month
  // onwards and nobody notices, because a dashboard is glanced at rather than
  // read. Every option must therefore be relative — no literal dates.
  const ids = PERIODS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate period id");
  for (const period of PERIODS) {
    assert.ok(period.label.length > 0, `${period.id} needs a label`);
    assert.ok(!/\d{4}/.test(period.label), `${period.label} looks like a fixed date rather than a window`);
    assert.ok(isPeriodId(period.id));
  }
  assert.ok(ids.includes("all"), '"all" must exist — it is the schema default');
  assert.equal(isPeriodId("1 March to 31 March"), false);
  assert.equal(isPeriodId(undefined), false);
});
