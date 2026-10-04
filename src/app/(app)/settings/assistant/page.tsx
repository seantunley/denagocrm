import { notFound } from "next/navigation";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PROFILE_KEY, DEFAULT_SOUL, LOCKED_RULES, TONES, parseProfile, type Tone } from "@/lib/assistantSoul";
import { saveAssistantProfile } from "@/app/actions/assistantSettings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";

export const dynamic = "force-dynamic";

const TONE_LABELS: Record<Tone, string> = {
  warm: "Warm",
  direct: "Direct",
  formal: "Formal",
  playful: "Playful",
};

export default async function AssistantSettingsPage() {
  await requireTenantOwner();
  if (!(await isModuleEnabled("automation"))) notFound();
  const profile = parseProfile(await getSetting(ASSISTANT_PROFILE_KEY));

  return (
    <SettingsWorkspace
      current="assistant"
      title="Assistant"
      description="Give the CRM's assistant a name and a personality. It answers your team's questions from your own records, in this voice."
      groups={SETTINGS_NAV_GROUPS}
    >
      <SaveForm action={saveAssistantProfile} resetOnSuccess={false} className="card max-w-2xl space-y-5 p-5">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <input name="name" defaultValue={profile.name} maxLength={40} className="input" placeholder="e.g. Ava" />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted-foreground">Tone</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(TONES) as Tone[]).map((tone) => (
              <label key={tone} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm has-[:checked]:border-primary">
                <input type="radio" name="tone" value={tone} defaultChecked={profile.tone === tone} className="mt-1 accent-primary" />
                <span>
                  <span className="block font-medium">{TONE_LABELS[tone]}</span>
                  <span className="block text-xs text-muted-foreground">{TONES[tone]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">House rules</span>
          <textarea
            name="rules"
            defaultValue={profile.rules}
            maxLength={1500}
            rows={6}
            className="input"
            placeholder={"Things it should always or never do, in your words. e.g.\n- Always mention the 5-year battery warranty when price comes up.\n- Never suggest a discount above 5%."}
          />
          <span className="block text-[11px] text-muted-foreground">
            It also learns your business as your team uses it — you&apos;ll be able to review what it has learned here.
          </span>
        </label>
        <details className="rounded-lg border border-border p-3" open={Boolean(profile.soul)}>
          <summary className="cursor-pointer text-sm font-medium">Advanced: its soul</summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              The whole personality in your words — how it thinks, talks and decides what to say. Rewrite it however
              you like. These are always added after it and can&apos;t be removed:
            </p>
            <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">{LOCKED_RULES}</pre>
            <textarea
              name="soul"
              defaultValue={profile.soul || DEFAULT_SOUL}
              maxLength={3000}
              rows={8}
              className="input font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Leave it as it is to keep the default — and get any improvements we make to it.
            </p>
          </div>
        </details>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <SaveButton>Save</SaveButton>
        </div>
      </SaveForm>
    </SettingsWorkspace>
  );
}
