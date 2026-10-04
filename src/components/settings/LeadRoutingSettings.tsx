"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { saveLeadRouting } from "@/app/actions/settings";
import { ROUND_ROBIN, type LeadRoutingConfig, type LeadRoutingRule } from "@/lib/leadRouting";

type Option = { id: string; name: string };

/**
 * Settings → Lead routing. Saving is explicit (one button), as with the weather
 * strip: this changes who every future inbound lead goes to.
 */
export default function LeadRoutingSettings({
  initial,
  staff,
  products,
  sources,
}: {
  initial: LeadRoutingConfig;
  staff: Option[];
  products: Option[];
  sources: string[];
}) {
  const [config, setConfig] = useState<LeadRoutingConfig>(initial);
  const [saving, startSave] = useTransition();
  const dirty = JSON.stringify(config) !== JSON.stringify(initial);

  const update = (patch: Partial<LeadRoutingConfig>) => setConfig({ ...config, ...patch });
  const setRule = (index: number, patch: Partial<LeadRoutingRule>) =>
    update({ rules: config.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  const toggleMember = (id: string) =>
    update({
      members: config.members.includes(id) ? config.members.filter((m) => m !== id) : [...config.members, id],
    });

  function save() {
    startSave(async () => {
      const result = await saveLeadRouting(config).catch(() => ({ error: "Could not save lead routing." }));
      if (result?.error) toast.error(result.error);
      else toast.success("Lead routing saved.");
    });
  }

  return (
    <div className="card max-w-2xl space-y-5 p-5">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={config.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        Automatically assign new inbound leads
      </label>

      <section className="space-y-2">
        <p className="text-sm font-semibold">Reps</p>
        <p className="text-xs text-muted-foreground">
          Who receives leads when no rule below matches. Disabled or removed users are skipped automatically.
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {staff.map((person) => (
            <label key={person.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={config.members.includes(person.id)} onChange={() => toggleMember(person.id)} />
              {person.name}
            </label>
          ))}
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">When no rule matches</span>
          <select
            className="input"
            value={config.mode}
            onChange={(e) => update({ mode: e.target.value === "fixed" ? "fixed" : "round_robin" })}
          >
            <option value="round_robin">Take turns (round robin)</option>
            <option value="fixed">Always the first rep ticked above</option>
          </select>
        </label>
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold">Rules</p>
        <p className="text-xs text-muted-foreground">
          Checked top to bottom; the first match wins. Leave source or product blank to match any.
        </p>
        <datalist id="lead-routing-sources">
          {sources.map((source) => (
            <option key={source} value={source} />
          ))}
        </datalist>
        {config.rules.map((rule, index) => (
          <div key={index} className="grid items-center gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              className="input"
              list="lead-routing-sources"
              placeholder="Any source"
              aria-label="Source"
              value={rule.source ?? ""}
              onChange={(e) => setRule(index, { source: e.target.value || undefined })}
            />
            <select
              className="input"
              aria-label="Product"
              value={rule.productId ?? ""}
              onChange={(e) => setRule(index, { productId: e.target.value || undefined })}
            >
              <option value="">Any product</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}</option>
              ))}
            </select>
            <select
              className="input"
              aria-label="Assign to"
              value={rule.assignTo}
              onChange={(e) => setRule(index, { assignTo: e.target.value })}
            >
              <option value={ROUND_ROBIN}>Round robin over reps</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => update({ rules: config.rules.filter((_, i) => i !== index) })}
              aria-label="Remove rule"
              className="flex size-8 items-center justify-center rounded text-muted-foreground hover:text-destructive"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => update({ rules: [...config.rules, { assignTo: ROUND_ROBIN }] })}
          className="btn inline-flex items-center gap-1"
        >
          <Plus className="size-3.5" /> Add rule
        </button>
      </section>

      <div className="border-t border-border/60 pt-4">
        <button type="button" onClick={save} disabled={!dirty || saving} className="btn btn-primary disabled:opacity-50">
          {saving ? "Saving…" : "Save lead routing"}
        </button>
      </div>
    </div>
  );
}
