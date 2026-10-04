import { notFound } from "next/navigation";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PROFILE_KEY, DEFAULT_SOUL, LOCKED_RULES, TONES, WORKSPACE_INSTRUCTIONS_CHARS, parseProfile, type Tone } from "@/lib/assistantSoul";
import { saveAssistantProfile } from "@/app/actions/assistantSettings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { prisma } from "@/lib/db";
import { listActingTenantStaff } from "@/lib/tenantActor";
import AssistantLearnedReview, { type LearnedNote } from "@/components/AssistantLearnedReview";
import { TIDY_LAST_KEY, TIDY_SUMMARY_KEY } from "@/lib/assistantTidy";
import { formatDateTime } from "@/lib/format";

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
  const [profile, notes, staff, tidiedAt, tidySummary] = await Promise.all([
    getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
    prisma.assistantNote.findMany({ orderBy: [{ status: "desc" }, { createdAt: "desc" }] }),
    listActingTenantStaff(),
    getSetting(TIDY_LAST_KEY),
    getSetting(TIDY_SUMMARY_KEY),
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
  const unreviewed = learned.filter((n) => n.status !== "approved").length;

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
          <span className="text-xs font-medium text-muted-foreground">Workspace instructions</span>
          <span className="block text-[11px] text-muted-foreground">
            Your standing orders for this workspace — like an AGENTS.md: how you work, what it must always or never do.
          </span>
          <textarea
            name="rules"
            defaultValue={profile.rules}
            maxLength={WORKSPACE_INSTRUCTIONS_CHARS}
            rows={8}
            className="input"
            placeholder={"In your words. e.g.\n- Always mention the 5-year battery warranty when price comes up.\n- Never suggest a discount above 5%.\n- Donovan handles fleet and golf-estate deals; Sean handles everything else.\n- We reply to every new lead within 2 hours."}
          />
        </label>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <SaveButton>Save</SaveButton>
        </div>
      </SaveForm>

      {/* Advanced: its soul, and everything it has learned — all editable. Open
          by default whenever there's something for the owner to look at. */}
      <details className="card mt-6 max-w-3xl p-5" open={Boolean(profile.soul) || unreviewed > 0}>
        <summary className="cursor-pointer text-base font-semibold">
          Advanced — its soul and what it has learned
          {unreviewed > 0 && (
            <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
              {unreviewed} to review
            </span>
          )}
        </summary>
        <div className="mt-5 space-y-8">
          <SaveForm action={saveAssistantProfile} resetOnSuccess={false} className="space-y-2">
            <h2 className="text-sm font-semibold">Its soul</h2>
            <p className="text-xs text-muted-foreground">
              The whole personality in your words — how it thinks, talks and decides what to say. Rewrite it however
              you like. These are always added after it and can&apos;t be removed:
            </p>
            <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">{LOCKED_RULES}</pre>
            <textarea name="soul" defaultValue={profile.soul || DEFAULT_SOUL} maxLength={3000} rows={8} className="input font-mono text-xs" />
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">Leave it as it is to keep the default — and get any improvements we make to it.</p>
              <SaveButton className="btn-primary btn-sm">Save soul</SaveButton>
            </div>
          </SaveForm>
          <p className="text-xs text-muted-foreground">
            Every night it tidies what it has learned — merging duplicates, dropping what&apos;s stale, flagging
            contradictions and improving playbooks from the day&apos;s corrections. Anything it changes shows up here as
            unreviewed; it never changes what you&apos;ve approved.{" "}
            {tidiedAt ? `Last tidy-up ${formatDateTime(new Date(tidiedAt))}: ${tidySummary ?? "in progress"}.` : "It hasn't tidied yet."}
          </p>
          <AssistantLearnedReview notes={learned} />
        </div>
      </details>
    </SettingsWorkspace>
  );
}
