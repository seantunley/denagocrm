"use client";

import { clearSecret } from "@/app/actions/settings";

/**
 * Owner-only "Clear" for a stored secret — the deliberate way to disconnect an
 * integration or remove a compromised key (a blank save only "keeps" now). Lives
 * INSIDE the field's existing save form and overrides its action via formAction,
 * so no nested <form>. Confirms first; the server action re-checks owner + an
 * allowlisted key.
 */
export default function ClearSecret({ settingKey, label }: { settingKey: string; label: string }) {
  return (
    <button
      type="submit"
      formAction={clearSecret.bind(null, settingKey)}
      className="btn-secondary"
      title={`Clear ${label}`}
      onClick={(e) => {
        if (!window.confirm(`Clear the ${label}? The integration stops working until a new value is saved.`)) {
          e.preventDefault();
        }
      }}
    >
      Clear
    </button>
  );
}
