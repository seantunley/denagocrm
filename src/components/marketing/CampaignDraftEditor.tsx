"use client";

import { useEffect, useRef, useState } from "react";
import { updateCampaignDraft } from "@/app/actions/marketingCampaignDrafts";
import { useMoneyFormat } from "@/components/MoneyFormatProvider";
import { currencySymbol } from "@/lib/format";
import { parseMoneyField } from "@/lib/moneyInput";

export type CampaignDraftEditorValue = {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  preheader: string | null;
  body: string;
  htmlBody: string | null;
  audience: string;
  segmentId: string | null;
  objective: string | null;
  offer: string | null;
  landingPageUrl: string | null;
  primaryCtaLabel: string | null;
  primaryCtaUrl: string | null;
  internalNotes: string | null;
  budgetCents: number | null;
  targetLeadCount: number | null;
  targetRevenueCents: number | null;
  successMetric: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  attributionWindowDays: number;
  status: string;
};

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * A money field typed in the currency's units and stored in cents. It keeps exactly what the person typed ("1.",
 * "1 000,5"), so no keystroke is rewritten; the cents change only when the text reads as a clear amount
 * (lib/moneyInput.ts, the same reading every money form uses). Blank clears it.
 */
function AmountInput({ cents, onCents }: { cents: number | null; onCents: (cents: number | null) => void }) {
  const money = useMoneyFormat();
  const [text, setText] = useState(cents == null ? "" : (cents / 100).toFixed(2));
  const parsed = parseMoneyField(text, money.currency);
  return (
    <>
      <input
        className="input tabular-nums"
        inputMode="decimal"
        placeholder={`${currencySymbol(money)} 0.00`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseMoneyField(e.target.value, money.currency);
          if (next.ok) onCents(next.cents);
        }}
      />
      {!parsed.ok && <span className="text-xs text-destructive">{parsed.error} Not saved until it is.</span>}
    </>
  );
}

function toForm(value: CampaignDraftEditorValue) {
  const form = new FormData();
  for (const [key, raw] of Object.entries(value)) {
    if (key === "id" || key === "status") continue;
    form.set(key, raw == null ? "" : String(raw));
  }
  return form;
}

export type CampaignAudienceOption = { id: string; name: string; count: number | null };

export default function CampaignDraftEditor({ initial, audiences }: { initial: CampaignDraftEditorValue; audiences: CampaignAudienceOption[] }) {
  const [value, setValue] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const first = useRef(true);
  const saved = useRef(JSON.stringify(initial));

  async function save(next = value) {
    setSaveState("saving");
    try {
      await updateCampaignDraft(initial.id, toForm(next));
      saved.current = JSON.stringify(next);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaveState("dirty");
    const timer = window.setTimeout(() => void save(value), 1500);
    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(value) !== saved.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [value]);

  const set = (key: keyof CampaignDraftEditorValue, raw: string) => {
    const numeric = new Set(["budgetCents", "targetLeadCount", "targetRevenueCents", "attributionWindowDays"]);
    setValue((current) => ({ ...current, [key]: numeric.has(key) ? (raw ? Number(raw) : null) : raw }));
  };

  return (
    <div className="space-y-5">
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-background/95 py-3 backdrop-blur">
        <div>
          <p className="text-sm font-medium">Campaign draft</p>
          <p className="text-xs text-muted-foreground">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : saveState === "dirty" ? "Unsaved changes" : "Ready"}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void save()}>Save draft</button>
      </div>

      <section className="card space-y-4">
        <h2 className="font-semibold">1. Brief</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1"><span className="label">Campaign name</span><input className="input" value={value.name} onChange={(e) => set("name", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Objective</span><input className="input" value={value.objective ?? ""} onChange={(e) => set("objective", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Offer</span><input className="input" value={value.offer ?? ""} onChange={(e) => set("offer", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Landing page</span><input className="input" type="url" value={value.landingPageUrl ?? ""} onChange={(e) => set("landingPageUrl", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">CTA label</span><input className="input" value={value.primaryCtaLabel ?? ""} onChange={(e) => set("primaryCtaLabel", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">CTA URL</span><input className="input" type="url" value={value.primaryCtaUrl ?? ""} onChange={(e) => set("primaryCtaUrl", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Budget</span><AmountInput cents={value.budgetCents} onCents={(cents) => setValue((current) => ({ ...current, budgetCents: cents }))} /></label>
          <label className="space-y-1"><span className="label">Target leads</span><input className="input" type="number" min="0" value={value.targetLeadCount ?? ""} onChange={(e) => set("targetLeadCount", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Target revenue</span><AmountInput cents={value.targetRevenueCents} onCents={(cents) => setValue((current) => ({ ...current, targetRevenueCents: cents }))} /></label>
          <label className="space-y-1"><span className="label">Success metric</span><input className="input" value={value.successMetric ?? ""} onChange={(e) => set("successMetric", e.target.value)} /></label>
        </div>
        <label className="space-y-1 block"><span className="label">Internal notes</span><textarea className="input min-h-24" value={value.internalNotes ?? ""} onChange={(e) => set("internalNotes", e.target.value)} /></label>
      </section>

      <section className="card space-y-4">
        <div><h2 className="font-semibold">2. Tracking and attribution</h2><p className="text-xs text-muted-foreground">Missing UTM values are safely defaulted at click time. Last-click attribution uses the selected lookback window.</p></div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1"><span className="label">UTM source</span><input className="input" placeholder="crm" value={value.utmSource ?? ""} onChange={(e) => set("utmSource", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">UTM medium</span><input className="input" placeholder={value.channel} value={value.utmMedium ?? ""} onChange={(e) => set("utmMedium", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">UTM campaign</span><input className="input" placeholder="campaign-name" value={value.utmCampaign ?? ""} onChange={(e) => set("utmCampaign", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">UTM content</span><input className="input" value={value.utmContent ?? ""} onChange={(e) => set("utmContent", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">UTM term</span><input className="input" value={value.utmTerm ?? ""} onChange={(e) => set("utmTerm", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Attribution window (days)</span><input className="input" type="number" min="1" max="180" value={value.attributionWindowDays} onChange={(e) => set("attributionWindowDays", e.target.value)} /></label>
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">3. Audience</h2>
        {/* A saved audience, never a typed label: a label with no audience behind it used to send to everyone. */}
        <label className="space-y-1 block">
          <span className="label">Who receives it</span>
          <select
            className="input"
            value={value.segmentId ?? ""}
            onChange={(e) => {
              const picked = audiences.find((a) => a.id === e.target.value);
              setValue((current) => ({ ...current, segmentId: picked?.id ?? null, audience: picked?.name ?? "" }));
            }}
          >
            <option value="">Choose a saved audience…</option>
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.count !== null ? ` (${a.count.toLocaleString()} last counted)` : ""}</option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          {audiences.length === 0 ? "You have no saved audiences yet. " : ""}
          Build or change audiences under <a href="/marketing/audiences" className="text-primary hover:underline">Audiences</a>. Only people who accept marketing are included, and the exact list is fixed when the approved campaign is scheduled or queued.
        </p>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">4. Content</h2>
        <label className="space-y-1 block"><span className="label">Channel</span><select className="input" value={value.channel} onChange={(e) => set("channel", e.target.value)}><option value="email">Email</option><option value="sms">SMS</option></select></label>
        {value.channel === "email" && <>
          <label className="space-y-1 block"><span className="label">Subject</span><input className="input" value={value.subject ?? ""} onChange={(e) => set("subject", e.target.value)} /></label>
          <label className="space-y-1 block"><span className="label">Preheader</span><input className="input" value={value.preheader ?? ""} onChange={(e) => set("preheader", e.target.value)} /></label>
          <label className="space-y-1 block"><span className="label">Email content (HTML code)</span><textarea className="input min-h-72 font-mono text-xs" value={value.htmlBody ?? ""} onChange={(e) => set("htmlBody", e.target.value)} /></label>
        </>}
        <label className="space-y-1 block"><span className="label">{value.channel === "sms" ? "Message" : "Plain-text fallback"}</span><textarea className="input min-h-40" value={value.body} onChange={(e) => set("body", e.target.value)} /></label>
        {value.channel === "sms" && <p className="text-xs text-muted-foreground">{value.body.length} characters</p>}
      </section>
    </div>
  );
}
