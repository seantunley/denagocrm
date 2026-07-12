"use client";

import { useMemo, useState } from "react";
import { JOURNEY_TRIGGERS, type JourneyDefinition, type JourneyTrigger } from "@/lib/marketingJourneys";

const LABELS: Record<JourneyTrigger, string> = {
  lead_created: "New lead created",
  stage_entered: "Lead enters a stage",
  lead_won: "Lead marked won",
  lead_lost: "Lead marked lost",
  quote_signed: "Quote signed",
  quote_declined: "Quote declined",
  delivered: "Delivery completed",
  referral_earned: "Referral earned",
  lead_idle: "Lead idle",
  purchase_anniversary: "Purchase anniversary",
  winback: "Win-back audience",
};

const EXAMPLE: JourneyDefinition = {
  entryConditions: {
    mode: "and",
    conditions: [{ field: "lead.valueCents", operator: "gte", value: 10000000 }],
  },
  steps: [
    { type: "create_activity", activityType: "call", summary: "Call {{name}}", dueHours: 2 },
    { type: "wait", hours: 24 },
    { type: "condition", conditions: { mode: "and", conditions: [{ field: "lead.status", operator: "eq", value: "open" }] }, onTrue: 3, onFalse: 5 },
    { type: "send_campaign", campaignId: "REPLACE_WITH_CAMPAIGN_ID" },
    { type: "wait", hours: 72 },
    { type: "end", reason: "journey completed" },
  ],
};

export default function MarketingJourneyForm({
  action,
  defaults,
  submitLabel = "Save draft",
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaults?: {
    name: string;
    description: string | null;
    trigger: JourneyTrigger;
    stopOnReply: boolean;
    respectMarketingConsent: boolean;
    frequencyCapHours: number;
    definition: JourneyDefinition;
  };
  submitLabel?: string;
}) {
  const [definition, setDefinition] = useState(
    JSON.stringify(defaults?.definition ?? EXAMPLE, null, 2)
  );
  const [validation, setValidation] = useState<string | null>(null);
  const lines = useMemo(() => definition.split("\n").length, [definition]);

  function validate() {
    try {
      JSON.parse(definition);
      setValidation("Valid JSON");
    } catch (error) {
      setValidation(error instanceof Error ? error.message : "Invalid JSON");
    }
  }

  return (
    <form action={action} className="space-y-5">
      <div className="grid md:grid-cols-2 gap-4">
        <label className="space-y-1">
          <span className="text-xs font-medium text-slate-300">Journey name</span>
          <input name="name" className="input" required defaultValue={defaults?.name ?? ""} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-slate-300">Trigger</span>
          <select name="trigger" className="input" defaultValue={defaults?.trigger ?? "lead_created"}>
            {JOURNEY_TRIGGERS.map((trigger) => (
              <option key={trigger} value={trigger}>{LABELS[trigger]}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="space-y-1 block">
        <span className="text-xs font-medium text-slate-300">Description</span>
        <textarea name="description" className="input min-h-20" defaultValue={defaults?.description ?? ""} />
      </label>

      <div className="grid md:grid-cols-3 gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="stopOnReply" defaultChecked={defaults?.stopOnReply ?? true} />
          Stop when customer replies
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="respectMarketingConsent" defaultChecked={defaults?.respectMarketingConsent ?? true} />
          Enforce marketing consent
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-slate-300">Frequency cap (hours)</span>
          <input name="frequencyCapHours" type="number" min="0" className="input" defaultValue={defaults?.frequencyCapHours ?? 24} />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Version definition</p>
            <p className="text-xs text-slate-400">Safe JSON only. Published versions are immutable.</p>
          </div>
          <button type="button" className="btn-secondary btn-sm" onClick={validate}>Validate JSON</button>
        </div>
        <textarea
          name="definition"
          value={definition}
          onChange={(event) => { setDefinition(event.target.value); setValidation(null); }}
          spellCheck={false}
          className="input font-mono text-xs leading-5 min-h-[420px]"
          style={{ height: Math.max(420, Math.min(900, lines * 20 + 40)) }}
          required
        />
        {validation && (
          <p className={`text-xs ${validation === "Valid JSON" ? "text-emerald-400" : "text-red-400"}`}>{validation}</p>
        )}
      </div>

      <details className="rounded-lg border border-slate-800 p-3 text-xs text-slate-400">
        <summary className="cursor-pointer font-medium text-slate-300">Supported steps and condition fields</summary>
        <div className="mt-3 space-y-2">
          <p><strong>Steps:</strong> wait, condition, send_campaign, send_email, create_activity, move_stage, assign_user, add_tag, remove_tag, send_push, end.</p>
          <p><strong>Operators:</strong> eq, neq, contains, gt, gte, lt, lte, empty, not_empty, in.</p>
          <p><strong>Fields:</strong> lead.*, contact.*, event.*. Examples: lead.source, lead.valueCents, lead.status, lead.stageId, contact.province, contact.marketingOptOut, event.vehicleModel.</p>
          <p>Use <code>send_campaign</code> for marketing messages so existing open/click tracking and unsubscribe handling remain active. Use <code>send_email</code> only for transactional or sales-service messages.</p>
        </div>
      </details>

      <button className="btn-primary">{submitLabel}</button>
    </form>
  );
}
