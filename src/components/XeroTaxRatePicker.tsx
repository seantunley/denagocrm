"use client";

import { useState } from "react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { chooseXeroTaxRate, listXeroTaxRateChoices } from "@/app/actions/xero";
import type { XeroTaxChoices } from "@/lib/xeroInvoice";

/**
 * Settings → Integrations → Xero → Sales tax. Where Xero has more than one live
 * sales rate at a VAT % (a South African organisation has six at 15%), pick which
 * one the CRM's VAT means — from a dropdown loaded from Xero, never typed.
 */
export default function XeroTaxRatePicker({ current }: { current: XeroTaxChoices }) {
  const [groups, setGroups] = useState<Array<{ pct: number; options: Array<{ taxType: string; name: string }> }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    const result = await listXeroTaxRateChoices().catch(() => ({ error: "Xero's tax rates couldn't be loaded." }));
    setLoading(false);
    if ("error" in result) setError(result.error);
    else setGroups(result.groups);
  };

  const chosen = Object.entries(current);
  return (
    <div className="space-y-2">
      <p className="label">Sales tax</p>
      {chosen.length > 0 ? (
        <ul className="text-sm">
          {chosen.map(([pct, c]) => (
            <li key={pct}>VAT at {pct}% → <b>{c.name}</b></li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Not chosen</p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Only needed where Xero has more than one sales rate at the same percentage. For ordinary 15% VAT, choose Standard Rate Sales.
      </p>
      {groups === null ? (
        <button type="button" className="btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? "Loading Xero's tax rates…" : chosen.length ? "Change" : "Choose from Xero"}
        </button>
      ) : groups.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Xero has one sales rate per percentage — nothing to choose.</p>
      ) : (
        groups.map((group) => {
          const saved = current[String(group.pct)];
          const stale = saved && !group.options.some((o) => o.taxType === saved.taxType);
          return (
            <SaveForm key={group.pct} action={chooseXeroTaxRate.bind(null, group.pct)} resetOnSuccess={false} className="flex flex-wrap items-center gap-2">
              <span className="text-sm">VAT at {group.pct}%</span>
              <select name="taxType" className="input !w-auto min-w-[14rem]" defaultValue={saved && !stale ? saved.taxType : ""}>
                {/* With a saved choice, the empty option CLEARS it; without one it's only the prompt. */}
                <option value="" disabled={!saved}>{saved ? "— Clear the choice —" : "Choose a rate…"}</option>
                {group.options.map((o) => (
                  <option key={o.taxType} value={o.taxType}>{o.name}</option>
                ))}
              </select>
              <SaveButton className="btn-primary btn-sm" pendingLabel="Saving…">Save</SaveButton>
              {stale && (
                <span className="text-[11px] text-amber-300">&ldquo;{saved.name}&rdquo; is no longer live in Xero — choose another, or clear it.</span>
              )}
            </SaveForm>
          );
        })
      )}
      {error && <p className="text-[11px] text-amber-300">{error}</p>}
    </div>
  );
}
