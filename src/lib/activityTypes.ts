/**
 * The activity types this workspace can schedule.
 *
 * They were seven hardcoded <option>s in five components. That is fine for one
 * business and wrong for a platform: a golf day is a real thing a dealer books,
 * it needs to SAY "Golf Day", and it needs the 📍 location field — but it is not
 * a meeting, and calling it one puts the wrong word on the diary, the timeline
 * and the audit trail.
 *
 * So a type is a label AND the behaviour it carries. The behaviour that actually
 * varies between them is the location field, which is why that is the one thing
 * a custom type chooses.
 *
 * THE SEVEN BUILT-INS STAY. They are not labels — they are wired:
 *   - `test_drive` is what a test-drive booking completes (actions/testDrives.ts)
 *   - `follow_up` carries a required note + auto-pin, enforced on create
 *   - `meeting`/`test_drive` are what the calendar counts and colours
 * Deleting one would break those silently, so they can be RENAMED and HIDDEN,
 * not removed. Renaming is the useful half anyway: a workshop calls a test drive
 * a "road test" and nothing about the wiring cares.
 *
 * Storage is one tenant-scoped AppSetting holding overrides + customs — not a
 * table, because `Activity.type` is already a free string and nothing joins on
 * it, so there is no migration and no backfill. A type that is deleted from the
 * list later leaves its old activities readable: `activityTypeLabel` falls back
 * to humanising the stored key rather than rendering a blank.
 *
 * This module is pure: parsing, validation and the defaults. No Prisma, no
 * `server-only` — the browser needs the same list to render the pickers, and a
 * rule the UI cannot import is a rule the UI reimplements slightly differently.
 */

export const ACTIVITY_TYPES_KEY = "ACTIVITY_TYPES";

/** Whether an activity of this type happens somewhere. */
export type LocationRule = "none" | "optional" | "required";

export type ActivityType = {
  /** What lands in `Activity.type`. Stable — the label can change, this cannot. */
  key: string;
  label: string;
  emoji: string;
  location: LocationRule;
  /** One of the seven wired built-ins: renameable, hideable, never deletable. */
  system: boolean;
  /** Kept working, but not offered in the pickers. */
  hidden: boolean;
};

/**
 * The built-ins, in picker order. `location` here is the WIRED behaviour and is
 * not editable — a test drive without an address is a test drive nobody can
 * attend, and the calendar's map link reads this field.
 */
export const SYSTEM_ACTIVITY_TYPES: readonly ActivityType[] = [
  { key: "call", label: "Call", emoji: "📞", location: "none", system: true, hidden: false },
  { key: "email", label: "Email", emoji: "✉️", location: "none", system: true, hidden: false },
  { key: "meeting", label: "Meeting", emoji: "🤝", location: "optional", system: true, hidden: false },
  { key: "whatsapp", label: "WhatsApp", emoji: "💬", location: "none", system: true, hidden: false },
  { key: "test_drive", label: "Test drive", emoji: "🚗", location: "required", system: true, hidden: false },
  { key: "follow_up", label: "Follow-up", emoji: "🔁", location: "none", system: true, hidden: false },
  { key: "todo", label: "To-do", emoji: "☑️", location: "none", system: true, hidden: false },
];

const SYSTEM_KEYS = new Set(SYSTEM_ACTIVITY_TYPES.map((type) => type.key));

/** Is this one of the wired built-ins? */
export function isSystemActivityType(key: string): boolean {
  return SYSTEM_KEYS.has(key);
}

/**
 * A cap, for the same reason the weather strip has one: the type picker is a
 * single <select> and a list this long is already unusable. It also bounds what
 * a compromised owner session can write into the setting.
 */
export const MAX_ACTIVITY_TYPES = 24;

const LOCATION_RULES: readonly LocationRule[] = ["none", "optional", "required"];

/**
 * Label → storage key. `Golf Day` → `golf_day`.
 *
 * Lowercase ASCII and underscores only, because this value is compared as a
 * string in a dozen places and rendered into audit summaries; letting punctuation
 * or case through would make `Golf Day` and `golf day` two different types that
 * look identical on screen.
 */
export function activityTypeKeyFrom(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/** `golf_day` → `Golf day`. The fallback for a type no longer in the list. */
function humanise(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Activity";
}

/** One stored entry → a clean override/custom, or null if it is unusable. */
function cleanEntry(raw: unknown): Partial<ActivityType> & { key: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;

  const key = typeof entry.key === "string" ? activityTypeKeyFrom(entry.key) : "";
  if (!key) return null;

  const label = typeof entry.label === "string" ? entry.label.trim().slice(0, 40) : "";
  const emoji = typeof entry.emoji === "string" ? entry.emoji.trim().slice(0, 8) : "";
  const location =
    typeof entry.location === "string" && (LOCATION_RULES as string[]).includes(entry.location)
      ? (entry.location as LocationRule)
      : undefined;

  return {
    key,
    ...(label ? { label } : {}),
    ...(emoji ? { emoji } : {}),
    ...(location ? { location } : {}),
    hidden: entry.hidden === true,
  };
}

function parseEntries(stored: string | null | undefined): (Partial<ActivityType> & { key: string })[] {
  if (stored == null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const entries: (Partial<ActivityType> & { key: string })[] = [];
  for (const item of raw) {
    const entry = cleanEntry(item);
    if (!entry) continue;
    if (entries.some((existing) => existing.key === entry.key)) continue;
    entries.push(entry);
    if (entries.length >= MAX_ACTIVITY_TYPES) break;
  }
  return entries;
}

/**
 * The stored value → the workspace's full type list, built-ins first.
 *
 * Total by construction. This feeds every scheduling form in the app; a setting
 * that is malformed, written by a newer release or edited by hand degrades to
 * the built-ins rather than leaving a rep with an empty type picker.
 *
 * Hidden types are RETURNED, not dropped — `activityTypeLabel` still needs them
 * to render existing activities, and `pickableActivityTypes` is what the forms
 * filter through.
 */
export function resolveActivityTypes(stored: string | null | undefined): ActivityType[] {
  const entries = parseEntries(stored);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));

  const resolved: ActivityType[] = SYSTEM_ACTIVITY_TYPES.map((type) => {
    const override = byKey.get(type.key);
    return {
      ...type,
      ...(override?.label ? { label: override.label } : {}),
      ...(override?.emoji ? { emoji: override.emoji } : {}),
      // `location` is deliberately NOT taken from the override for a built-in:
      // it is wired behaviour, not presentation.
      hidden: override?.hidden === true,
    };
  });

  for (const entry of entries) {
    if (SYSTEM_KEYS.has(entry.key)) continue;
    // A custom type with no label is not a type anybody can pick.
    if (!entry.label) continue;
    resolved.push({
      key: entry.key,
      label: entry.label,
      emoji: entry.emoji || "📌",
      location: entry.location ?? "none",
      system: false,
      hidden: entry.hidden === true,
    });
    if (resolved.length >= MAX_ACTIVITY_TYPES) break;
  }

  return resolved;
}

/**
 * The value to store. Runs the same cleaning as the read, so a write cannot save
 * something a read would reject, and drops everything that is already the
 * built-in default — the setting holds the DIFFERENCE, so a workspace that
 * renames nothing stores nothing and keeps tracking future default changes.
 */
export function serialiseActivityTypes(types: readonly ActivityType[]): string {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const type of types) {
    // No fallback to the label. An entry without a key is not a type — inventing
    // one here would mean a malformed payload silently becomes a real type with
    // a key nobody chose, which is then what every future activity is stored as.
    const key = activityTypeKeyFrom(type.key ?? "");
    if (!key || seen.has(key)) continue;

    const label = String(type.label ?? "").trim().slice(0, 40);
    const emoji = String(type.emoji ?? "").trim().slice(0, 8);
    const hidden = type.hidden === true;

    if (SYSTEM_KEYS.has(key)) {
      const base = SYSTEM_ACTIVITY_TYPES.find((system) => system.key === key)!;
      const renamed = label && label !== base.label;
      const reskinned = emoji && emoji !== base.emoji;
      // Untouched built-in: store nothing at all.
      if (!renamed && !reskinned && !hidden) continue;
      out.push({
        key,
        ...(renamed ? { label } : {}),
        ...(reskinned ? { emoji } : {}),
        ...(hidden ? { hidden: true } : {}),
      });
    } else {
      if (!label) continue;
      const location = (LOCATION_RULES as string[]).includes(type.location)
        ? type.location
        : "none";
      out.push({ key, label, emoji: emoji || "📌", location, ...(hidden ? { hidden: true } : {}) });
    }

    seen.add(key);
    if (out.length >= MAX_ACTIVITY_TYPES) break;
  }

  return JSON.stringify(out);
}

/** What the scheduling forms offer. */
export function pickableActivityTypes(types: readonly ActivityType[]): ActivityType[] {
  return types.filter((type) => !type.hidden);
}

export function findActivityType(
  types: readonly ActivityType[],
  key: string
): ActivityType | null {
  return types.find((type) => type.key === key) ?? null;
}

/** The label for a stored key — humanised from the key if the type is gone. */
export function activityTypeLabel(types: readonly ActivityType[], key: string): string {
  return findActivityType(types, key)?.label ?? humanise(key);
}

export function activityTypeEmoji(types: readonly ActivityType[], key: string): string {
  return findActivityType(types, key)?.emoji ?? "☑️";
}

/** Does this type take a location, and must it have one? */
export function activityTypeLocation(types: readonly ActivityType[], key: string): LocationRule {
  return findActivityType(types, key)?.location ?? "none";
}
