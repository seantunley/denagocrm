"use client";

import { useState } from "react";
import LocationAutocomplete from "@/components/LocationAutocomplete";
import { useActivityTypes } from "@/components/ActivityTypesProvider";
import { activityTypeLocation, pickableActivityTypes } from "@/lib/activityTypes";

/**
 * Type selector + conditional location.
 *
 * The 📍 field is driven by the TYPE'S OWN location rule rather than a hardcoded
 * `test_drive || meeting` check — that check was why a workspace wanting to book
 * a "Golf Day" had to call it a meeting to get an address field. A custom type
 * declares whether it takes a location when it is created, in settings.
 *
 * When `followUpNote` is set (the create flow), picking "Follow-up" reveals a
 * REQUIRED note field so the rep records what the customer said they'd get back
 * to us about.
 */
export default function ActivityTypeFields({
  defaultType = "call",
  defaultLocation = "",
  locationClass = "col-span-2 md:col-span-3",
  followUpNote = false,
  noteClass = "col-span-2 md:col-span-4",
}: {
  defaultType?: string;
  defaultLocation?: string;
  locationClass?: string;
  followUpNote?: boolean;
  noteClass?: string;
}) {
  const [type, setType] = useState(defaultType);
  const types = useActivityTypes();
  const locationRule = activityTypeLocation(types, type);
  const isFollowUp = type === "follow_up";

  /*
    Hidden types are filtered out, EXCEPT the one this activity already has —
    otherwise opening the edit form on an activity whose type was since hidden
    would show a <select> matching no option, and the browser would silently
    select the first one. Saving would then change the type without anybody
    touching it. Same reason the assignee select keeps a blank option.

    Follow-up carries invariants (a required note + auto-pin) that only the
    create flow enforces, so it is offered only when `followUpNote` is set. The
    edit form omits that prop, so editing a task into a noteless/unpinned
    follow-up is impossible.
  */
  const options = types.filter(
    (option) =>
      option.key === defaultType ||
      (pickableActivityTypes(types).includes(option) &&
        (option.key !== "follow_up" || followUpNote))
  );

  return (
    <>
      <div>
        <label className="label">Type</label>
        <select
          name="type"
          className="input"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.emoji} {option.label}
            </option>
          ))}
        </select>
      </div>
      {locationRule !== "none" && (
        <div className={locationClass}>
          <label className="label">
            📍 Location {locationRule === "required" ? "*" : "(optional)"}
          </label>
          <LocationAutocomplete
            name="location"
            className="input"
            required={locationRule === "required"}
            defaultValue={defaultLocation}
            placeholder="Address, estate or Google Maps link"
          />
        </div>
      )}
      {followUpNote && isFollowUp && (
        <div className={noteClass}>
          <label className="label">🔁 Follow-up note *</label>
          <textarea
            name="note"
            className="input min-h-20 w-full resize-y"
            required
            placeholder="e.g. Customer will get back to us in 2 weeks after speaking to their partner"
          />
          <p className="mt-1 text-xs text-slate-500">
            Pick a future date and time above — this follow-up pins to the top of
            the timeline and nudges the assignee when it&apos;s due.
          </p>
        </div>
      )}
    </>
  );
}
