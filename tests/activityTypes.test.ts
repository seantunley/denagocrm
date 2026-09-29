import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  activityTypeKeyFrom,
  activityTypeLabel,
  activityTypeLocation,
  findActivityType,
  pickableActivityTypes,
  resolveActivityTypes,
  serialiseActivityTypes,
  SYSTEM_ACTIVITY_TYPES,
  MAX_ACTIVITY_TYPES,
  type ActivityType,
} from "../src/lib/activityTypes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/**
 * Activity types were seven hardcoded <option>s. A dealer booking a golf day had
 * to file it as a "meeting" to get the location field, which put the wrong word
 * on the diary, the timeline and the audit trail.
 */

/* ── the thing that was actually asked for ─────────────────────────── */

test("A CUSTOM TYPE CARRIES ITS OWN NAME AND A LOCATION, WITHOUT BEING A MEETING", () => {
  const stored = serialiseActivityTypes([
    ...SYSTEM_ACTIVITY_TYPES,
    { key: "golf_day", label: "Golf Day", emoji: "⛳", location: "optional", system: false, hidden: false },
  ]);
  const types = resolveActivityTypes(stored);

  const golf = findActivityType(types, "golf_day");
  assert.ok(golf, "the custom type survived a save/load round trip");
  assert.equal(golf!.label, "Golf Day", "it says Golf Day, not Meeting");
  assert.equal(golf!.key, "golf_day", "and it is stored as its OWN type");

  // The whole point: the location field is driven by the type's rule, so this
  // gets an address without being filed as a meeting.
  assert.equal(activityTypeLocation(types, "golf_day"), "optional");
  assert.notEqual(golf!.key, "meeting");
});

test("THE LOCATION FIELD FOLLOWS THE TYPE'S RULE, NOT A HARDCODED PAIR", () => {
  /*
   * ActivityTypeFields used to ask `type === "test_drive" || type === "meeting"`.
   * That is the line that forced the golf day to be a meeting, so it must not
   * come back — the component has to consult the resolved type instead.
   */
  const component = stripComments(src("src/components/ActivityTypeFields.tsx"));
  assert.ok(
    !/type === "meeting"/.test(component),
    "the location field is no longer gated on a hardcoded type name",
  );
  assert.match(
    component,
    /activityTypeLocation\(/,
    "it asks the type what its location rule is",
  );
});

/* ── the built-ins are wired, so they cannot be deleted ────────────── */

test("A BUILT-IN CAN BE RENAMED BUT NOT REMOVED", () => {
  // A workspace calls a test drive a "road test". The label changes; the key —
  // which actions/testDrives.ts completes by name — does not.
  const stored = serialiseActivityTypes(
    SYSTEM_ACTIVITY_TYPES.map((type) =>
      type.key === "test_drive" ? { ...type, label: "Road test" } : type,
    ),
  );
  const types = resolveActivityTypes(stored);

  assert.equal(activityTypeLabel(types, "test_drive"), "Road test");
  assert.equal(findActivityType(types, "test_drive")!.key, "test_drive");

  // Even a stored value that tries to drop the built-ins entirely gets them back:
  // resolve() re-seeds from SYSTEM_ACTIVITY_TYPES rather than trusting storage.
  const wiped = resolveActivityTypes(JSON.stringify([{ key: "golf_day", label: "Golf Day" }]));
  for (const system of SYSTEM_ACTIVITY_TYPES) {
    assert.ok(findActivityType(wiped, system.key), `${system.key} survived a list that omitted it`);
  }
});

test("A BUILT-IN'S LOCATION RULE IS WIRED BEHAVIOUR AND IGNORES OVERRIDES", () => {
  // A test drive without an address is a test drive nobody can attend, and the
  // calendar's map link reads this field. Renaming must not be able to unwire it.
  const types = resolveActivityTypes(
    JSON.stringify([{ key: "test_drive", label: "Road test", location: "none" }]),
  );
  assert.equal(activityTypeLocation(types, "test_drive"), "required");
});

test("HIDING A TYPE KEEPS EXISTING ACTIVITIES READABLE", () => {
  const types = resolveActivityTypes(JSON.stringify([{ key: "whatsapp", hidden: true }]));

  assert.ok(
    !pickableActivityTypes(types).some((type) => type.key === "whatsapp"),
    "it is no longer offered",
  );
  assert.equal(
    activityTypeLabel(types, "whatsapp"),
    "WhatsApp",
    "but a WhatsApp activity already in the diary still has a name",
  );
});

test("A TYPE DELETED ALTOGETHER LEAVES ITS OLD ACTIVITIES WITH A READABLE NAME", () => {
  // `Activity.type` is a free string and nothing joins on it, so a removed
  // custom type leaves rows behind. They must not render blank.
  const types = resolveActivityTypes("[]");
  assert.equal(activityTypeLabel(types, "golf_day"), "Golf day");
  assert.equal(activityTypeLabel(types, ""), "Activity");
});

/* ── storage ───────────────────────────────────────────────────────── */

test("AN UNTOUCHED WORKSPACE STORES NOTHING", () => {
  // The setting holds the DIFFERENCE from the defaults, so a workspace that
  // renames nothing keeps inheriting future built-in changes instead of
  // freezing today's labels into its own row.
  assert.equal(serialiseActivityTypes(SYSTEM_ACTIVITY_TYPES), "[]");
});

test("A WRITE CANNOT STORE WHAT A READ WOULD REJECT", () => {
  const junk = [
    { key: "", label: "No key" },
    { key: "no_label" },
    { key: "GOLF DAY!", label: "Golf Day", emoji: "⛳", location: "wormhole" },
  ] as unknown as ActivityType[];

  const types = resolveActivityTypes(serialiseActivityTypes(junk));
  const customs = types.filter((type) => !type.system);

  assert.equal(customs.length, 1, "only the one usable entry survived");
  assert.equal(customs[0].key, "golf_day", "the key was normalised from the label");
  assert.equal(customs[0].location, "none", "an unknown location rule fell back, it did not throw");
});

test("A MALFORMED SETTING DEGRADES TO THE BUILT-INS RATHER THAN AN EMPTY PICKER", () => {
  // This feeds every scheduling form in the app. A hand-edited or
  // newer-release value must not leave a rep unable to book anything.
  for (const stored of [null, undefined, "", "not json", '"a string"', "{}", "[1,2,3]"]) {
    const types = resolveActivityTypes(stored);
    assert.equal(
      types.length,
      SYSTEM_ACTIVITY_TYPES.length,
      `"${stored}" fell back to the built-ins`,
    );
    assert.ok(pickableActivityTypes(types).length > 0);
  }
});

test("THE LIST IS CAPPED", () => {
  const many: ActivityType[] = Array.from({ length: 60 }, (_, index) => ({
    key: `custom_${index}`,
    label: `Custom ${index}`,
    emoji: "📌",
    location: "none" as const,
    system: false,
    hidden: false,
  }));
  assert.ok(resolveActivityTypes(serialiseActivityTypes(many)).length <= MAX_ACTIVITY_TYPES);
});

test("KEYS ARE NORMALISED SO TWO NAMES CANNOT BECOME ONE SILENT TYPE", () => {
  assert.equal(activityTypeKeyFrom("Golf Day"), "golf_day");
  assert.equal(activityTypeKeyFrom("  Golf   Day!  "), "golf_day");
  assert.equal(activityTypeKeyFrom("golf day"), "golf_day");
  assert.equal(activityTypeKeyFrom("!!!"), "");

  // Same key twice is one type, not two rows that look identical on screen.
  const types = resolveActivityTypes(
    serialiseActivityTypes([
      { key: "golf_day", label: "Golf Day", emoji: "⛳", location: "optional", system: false, hidden: false },
      { key: "Golf Day", label: "Golf day", emoji: "🏌️", location: "none", system: false, hidden: false },
    ]),
  );
  assert.equal(types.filter((type) => type.key === "golf_day").length, 1);
});

/* ── the wiring, not just the rule ─────────────────────────────────── */

test("EVERY TYPE PICKER READS THE WORKSPACE LIST", () => {
  /*
   * Five components rendered their own hardcoded <option> list. A custom type
   * that only appears in one of them is worse than none: the rep books a Golf
   * Day from the lead page and cannot find it in quick-create.
   */
  for (const file of [
    "src/components/ActivityTypeFields.tsx",
    "src/components/QuickCreateDialog.tsx",
    "src/components/proactive/NextStep.tsx",
  ]) {
    const code = stripComments(src(file));
    assert.match(code, /useActivityTypes\(\)/, `${file} reads the workspace list`);
    assert.ok(
      !/<option value="test_drive">/.test(code),
      `${file} no longer hardcodes the type options`,
    );
  }
});

test("THE LIST ENTERS THE CLIENT TREE AT THE SHELL", () => {
  // getSetting resolves the tenant from the request scope, which no client
  // component can reach — so the layout is the only place this can be read, and
  // the provider is what every picker below it consults.
  const layout = stripComments(src("src/app/(app)/layout.tsx"));
  assert.match(layout, /resolveActivityTypes\(await getSetting\(ACTIVITY_TYPES_KEY\)\)/);
  assert.match(layout, /activityTypes=\{activityTypes\}/);

  const shell = stripComments(src("src/components/AppShell.tsx"));
  assert.match(shell, /<ActivityTypesProvider types=\{activityTypes\}>/);
});

test("THE SAVE IS OWNER-ONLY AND CANNOT LOSE A BUILT-IN", () => {
  const action = stripComments(src("src/app/actions/settings.ts"));
  const start = action.indexOf("export async function saveActivityTypes");
  assert.ok(start > 0, "the action exists");
  const body = action.slice(start, start + 2000);

  assert.match(body, /await requireOwner\(\)/, "only an owner may change the workspace's types");
  assert.match(
    body,
    /SYSTEM_ACTIVITY_TYPES\.map\(/,
    "built-ins are re-seeded from source, not trusted from the client payload",
  );
  assert.match(body, /type\.hidden\)/, "an all-hidden list is refused");
});
