"use client";

import { useState } from "react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { listXeroItems } from "@/app/actions/xero";
import type { ActionResult } from "@/lib/actionResultTypes";

/**
 * "Xero item" — pick one of the items Xero sells from a dropdown (never typed).
 * The list is fetched from Xero only when "Choose" is pressed, not on every page
 * view. Used for a product's link and for the delivery / other fee items.
 */
export default function XeroItemPicker({
  label,
  current,
  action,
  hint,
}: {
  label: string;
  current: { code: string; name: string } | null;
  /** Bound save action; posts `xeroItemId` ("" = unlink). */
  action: (formData: FormData) => Promise<ActionResult | void>;
  hint?: string;
}) {
  const [items, setItems] = useState<Array<{ id: string; code: string; name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    const result = await listXeroItems().catch(() => ({ error: "Xero's items couldn't be loaded." }));
    setLoading(false);
    if ("error" in result) setError(result.error);
    else setItems(result.items);
  };

  return (
    <div className="space-y-2">
      <p className="label">{label}</p>
      <p className="text-sm">
        {current ? (
          <>
            <code className="rounded bg-muted px-1">{current.code}</code> {current.name}
          </>
        ) : (
          <span className="text-muted-foreground">Not linked</span>
        )}
      </p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {items === null ? (
        <button type="button" className="btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? "Loading Xero items…" : current ? "Change" : "Choose from Xero"}
        </button>
      ) : (
        <SaveForm action={action} resetOnSuccess={false} className="flex flex-wrap items-center gap-2">
          <select name="xeroItemId" className="input !w-auto min-w-[14rem]" defaultValue="">
            <option value="" disabled={!current}>{current ? "— Unlink —" : "Choose an item…"}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code}{item.name ? ` — ${item.name}` : ""}
              </option>
            ))}
          </select>
          <SaveButton className="btn-primary btn-sm" pendingLabel="Saving…">Save</SaveButton>
          {items.length === 0 && <span className="text-[11px] text-amber-300">Xero has no items it sells yet — add them in Xero first.</span>}
        </SaveForm>
      )}
      {error && <p className="text-[11px] text-amber-300">{error}</p>}
    </div>
  );
}
