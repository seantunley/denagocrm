import { notFound } from "next/navigation";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PROFILE_KEY, TONES, parseProfile, type Tone } from "@/lib/assistantSoul";
import { saveAssistantProfile } from "@/app/actions/assistantSettings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { prisma } from "@/lib/db";
import { listActingTenantStaff } from "@/lib/tenantActor";
import AssistantLearnedReview, { type LearnedNote } from "@/components/AssistantLearnedReview";

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
  const [profile, notes, staff] = await Promise.all([
    getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
    prisma.assistantNote.findMany({ orderBy: [{ status: "desc" }, { createdAt: "desc" }] }),
    listActingTenantStaff(),
  ]);
  const nameOf = new Map(staff.map((s) => [s.id, s.name]));
  const learned: LearnedNote[] = notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    description: n.description,
    content: n.content,
    status: n.status,
    createdAt: n.createdAt,
    about: n.kind === "profile" && n.userId ? nameOf.get(n.userId) ?? "a former team member" : null,
    taughtBy: n.createdById ? nameOf.get(n.createdById) ?? null : null,
  }));

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
            It also learns your business as your team uses it — review what it has learned below.
          </span>
        </label>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <SaveButton>Save</SaveButton>
        </div>
      </SaveForm>
      <div className="mt-8">
        <AssistantLearnedReview notes={learned} />
      </div>
    </SettingsWorkspace>
  );
}
