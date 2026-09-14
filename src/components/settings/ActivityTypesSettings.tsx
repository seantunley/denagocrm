"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { saveActivityTypes } from "@/app/actions/settings";
import {
  activityTypeKeyFrom,
  MAX_ACTIVITY_TYPES,
  type ActivityType,
  type LocationRule,
} from "@/lib/activityTypes";

/**
 * What this workspace can schedule.
 *
 * The built-ins are RENAME-ONLY. They are wired into other features — a
 * test-drive booking completes a `test_drive`, a follow-up enforces a note — so
 * the screen offers what is actually safe: change what it is called, change its
 * emoji, or stop offering it. There is no delete button to explain away.
 *
 * A custom type chooses its LOCATION RULE, which is the only behaviour that
 * meaningfully varies. That is the whole point of the screen: a golf day needs
 * its own name and an address field, and before this it had to be filed as a
 * meeting to get one.
 *
 * Saving is explicit. This changes what every person in the workspace sees in
 * every scheduling form, which is not a thing to commit on a keystroke.
 */
export default function ActivityTypesSettings({ initial }: { initial: ActivityType[] }) {
  const [types, setTypes] = useState<ActivityType[]>(initial);
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
  const [location, setLocation] = useState<LocationRule>("none");
  const [saving, startSave] = useTransition();

  const dirty = JSON.stringify(types) !== JSON.stringify(initial);
  const full = types.length >= MAX_ACTIVITY_TYPES;

  function update(key: string, patch: Partial<ActivityType>) {
    setTypes((current) =>
      current.map((type) => (type.key === key ? { ...type, ...patch } : type))
    );
  }

  function add() {
    const name = label.trim();
    if (!name) return;
    const key = activityTypeKeyFrom(name);
    // Not a nicety: two types sharing a key are one type with two rows on this
    // screen, and whichever saves last silently wins.
    if (!key) {
      toast.error("Give it a name with at least one letter or number.");
      return;
    }
    if (types.some((type) => type.key === key)) {
      toast.error(`“${name}” is already on the list.`);
      return;
    }
    setTypes([
      ...types,
      { key, label: name, emoji: emoji.trim() || "📌", location, system: false, hidden: false },
    ]);
    setLabel("");
    setEmoji("");
    setLocation("none");
  }

  function save() {
    startSave(async () => {
      const result = await saveActivityTypes(types).catch(() => ({
        error: "Could not save the activity types.",
      }));
      if (result?.error) toast.error(result.error);
      else toast.success("Activity types updated.");
    });
  }

  const field =
    "w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Activity types</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          What this workspace can schedule. Everyone here sees the same list. Up to{" "}
          {MAX_ACTIVITY_TYPES}.
        </p>
      </div>

      <ul className="space-y-1.5">
        {types.map((type) => (
          <li
            key={type.key}
            className={`flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 ${
              type.hidden ? "opacity-55" : ""
            }`}
          >
            <input
              value={type.emoji}
              onChange={(event) => update(type.key, { emoji: event.target.value.slice(0, 8) })}
              aria-label={`Emoji for ${type.label}`}
              className={`${field} w-14 text-center text-base`}
            />
            <input
              value={type.label}
              onChange={(event) => update(type.key, { label: event.target.value.slice(0, 40) })}
              aria-label={`Name for ${type.label}`}
              className={`${field} flex-1`}
            />

            {/* The location rule is fixed for a built-in — it is wired behaviour,
                not presentation — so it is shown as text rather than a control
                that looks editable and silently isn't. */}
            {type.system ? (
              <span className="hidden w-36 shrink-0 text-xs text-muted-foreground sm:block">
                {type.location === "required"
                  ? "📍 Location required"
                  : type.location === "optional"
                    ? "📍 Location optional"
                    : "Built-in"}
              </span>
            ) : (
              <select
                value={type.location}
                onChange={(event) =>
                  update(type.key, { location: event.target.value as LocationRule })
                }
                aria-label={`Location for ${type.label}`}
                className={`${field} w-36 shrink-0`}
              >
                <option value="none">No location</option>
                <option value="optional">📍 Optional</option>
                <option value="required">📍 Required</option>
              </select>
            )}

            <button
              type="button"
              onClick={() => update(type.key, { hidden: !type.hidden })}
              title={type.hidden ? "Show in the pickers" : "Stop offering this type"}
              aria-label={type.hidden ? `Show ${type.label}` : `Hide ${type.label}`}
              className="flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              {type.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>

            {/* A built-in has no remove button at all: other features schedule
                and complete these by key, so removing one would break them
                somewhere else entirely. Hiding it is the honest equivalent. */}
            {type.system ? (
              <span className="w-6" />
            ) : (
              <button
                type="button"
                onClick={() => setTypes(types.filter((entry) => entry.key !== type.key))}
                aria-label={`Remove ${type.label}`}
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="rounded-lg border border-dashed border-border p-3">
        <p className="text-xs font-medium text-foreground">Add your own</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A golf day, a site survey, a handover — anything your team books. Pick whether it
          carries a location.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            value={emoji}
            onChange={(event) => setEmoji(event.target.value.slice(0, 8))}
            placeholder="⛳"
            aria-label="Emoji"
            className={`${field} w-14 text-center text-base`}
          />
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value.slice(0, 40))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            placeholder="Golf Day"
            aria-label="Name"
            className={`${field} min-w-40 flex-1`}
          />
          <select
            value={location}
            onChange={(event) => setLocation(event.target.value as LocationRule)}
            aria-label="Location"
            className={`${field} w-36`}
          >
            <option value="none">No location</option>
            <option value="optional">📍 Optional</option>
            <option value="required">📍 Required</option>
          </select>
          <button
            type="button"
            onClick={add}
            disabled={!label.trim() || full}
            className="btn-secondary btn-sm inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            Add
          </button>
        </div>
        {full && (
          <p className="mt-2 text-xs text-amber-400">
            That is the maximum of {MAX_ACTIVITY_TYPES}. Remove or hide one first.
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="btn-primary disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save activity types"}
        </button>
        {dirty && !saving && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
