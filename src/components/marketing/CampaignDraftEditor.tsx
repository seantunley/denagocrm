"use client";

import { useEffect, useRef, useState } from "react";
import { updateCampaignDraft } from "@/app/actions/marketingCampaignDrafts";

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
  status: string;
};

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function toForm(value: CampaignDraftEditorValue) {
  const form = new FormData();
  for (const [key, raw] of Object.entries(value)) {
    if (key === "id" || key === "status") continue;
    form.set(key, raw == null ? "" : String(raw));
  }
  return form;
}

export default function CampaignDraftEditor({ initial }: { initial: CampaignDraftEditorValue }) {
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
    const numeric = new Set(["budgetCents", "targetLeadCount", "targetRevenueCents"]);
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
          <label className="space-y-1"><span className="label">Budget (cents)</span><input className="input" type="number" min="0" value={value.budgetCents ?? ""} onChange={(e) => set("budgetCents", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Target leads</span><input className="input" type="number" min="0" value={value.targetLeadCount ?? ""} onChange={(e) => set("targetLeadCount", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Target revenue (cents)</span><input className="input" type="number" min="0" value={value.targetRevenueCents ?? ""} onChange={(e) => set("targetRevenueCents", e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Success metric</span><input className="input" value={value.successMetric ?? ""} onChange={(e) => set("successMetric", e.target.value)} /></label>
        </div>
        <label className="space-y-1 block"><span className="label">Internal notes</span><textarea className="input min-h-24" value={value.internalNotes ?? ""} onChange={(e) => set("internalNotes", e.target.value)} /></label>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">2. Audience</h2>
        <label className="space-y-1 block"><span className="label">Audience label</span><input className="input" value={value.audience} onChange={(e) => set("audience", e.target.value)} /></label>
        <p className="text-xs text-muted-foreground">Saved segments and live audience preview are connected in the audience and approval PRs. This draft remains safe and unsent.</p>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">3. Content</h2>
        <label className="space-y-1 block"><span className="label">Channel</span><select className="input" value={value.channel} onChange={(e) => set("channel", e.target.value)}><option value="email">Email</option><option value="sms">SMS</option></select></label>
        {value.channel === "email" && <>
          <label className="space-y-1 block"><span className="label">Subject</span><input className="input" value={value.subject ?? ""} onChange={(e) => set("subject", e.target.value)} /></label>
          <label className="space-y-1 block"><span className="label">Preheader</span><input className="input" value={value.preheader ?? ""} onChange={(e) => set("preheader", e.target.value)} /></label>
          <label className="space-y-1 block"><span className="label">Email HTML</span><textarea className="input min-h-72 font-mono text-xs" value={value.htmlBody ?? ""} onChange={(e) => set("htmlBody", e.target.value)} /></label>
        </>}
        <label className="space-y-1 block"><span className="label">{value.channel === "sms" ? "Message" : "Plain-text fallback"}</span><textarea className="input min-h-40" value={value.body} onChange={(e) => set("body", e.target.value)} /></label>
        {value.channel === "sms" && <p className="text-xs text-muted-foreground">{value.body.length} characters</p>}
      </section>
    </div>
  );
}
