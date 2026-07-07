"use client";

import { useState } from "react";

/**
 * Type selector + conditional location: test drives and meetings happen
 * somewhere, so the 📍 field appears (required for test drives).
 */
export default function ActivityTypeFields({
  defaultType = "call",
  defaultLocation = "",
  locationClass = "col-span-2 md:col-span-3",
}: {
  defaultType?: string;
  defaultLocation?: string;
  locationClass?: string;
}) {
  const [type, setType] = useState(defaultType);
  const needsLocation = type === "test_drive" || type === "meeting";

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
          <option value="call">Call</option>
          <option value="email">Email</option>
          <option value="meeting">Meeting</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="test_drive">🚗 Test drive</option>
          <option value="todo">To-do</option>
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
    </>
  );
}
