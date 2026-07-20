"use client";

import { useState } from "react";

/**
 * Type selector + conditional location: test drives and meetings happen
 * somewhere, so the 📍 field appears (required for test drives). When
 * `followUpNote` is set (the create flow), picking "Follow-up" reveals a
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
  const needsLocation = type === "test_drive" || type === "meeting";
  const isFollowUp = type === "follow_up";

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
          <option value="call">📞 Call</option>
          <option value="email">✉️ Email</option>
          <option value="meeting">🤝 Meeting</option>
          <option value="whatsapp">💬 WhatsApp</option>
          <option value="test_drive">🚗 Test drive</option>
          {/*
            Follow-up carries invariants (a required note + auto-pin) that only
            the create flow enforces, so it is offered only when `followUpNote`
            is set. The edit form omits that prop, so editing a task into a
            noteless/unpinned follow-up is impossible.
          */}
          {(followUpNote || defaultType === "follow_up") && (
            <option value="follow_up">🔁 Follow-up</option>
          )}
          <option value="todo">☑️ To-do</option>
        </select>
      </div>
      {needsLocation && (
        <div className={locationClass}>
          <label className="label">
            📍 Location {type === "test_drive" ? "*" : "(optional)"}
          </label>
          <input
            name="location"
            className="input"
            required={type === "test_drive"}
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
