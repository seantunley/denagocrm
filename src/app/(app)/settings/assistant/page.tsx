import { notFound } from "next/navigation";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PROFILE_KEY, DEFAULT_SOUL, LOCKED_RULES, TONES, WORKSPACE_INSTRUCTIONS_CHARS, parseProfile, type Tone } from "@/lib/assistantSoul";
import { saveAssistantProfile, saveAssistantWhatsAppCard } from "@/app/actions/assistantSettings";
import { ASSISTANT_VOICE_REPLIES_KEY, voiceRepliesSwitchOn } from "@/lib/assistantVoiceRules";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { basePrisma, prisma } from "@/lib/db";
import { listActingTenantStaff } from "@/lib/tenantActor";
import AssistantLearnedReview, { type LearnedNote } from "@/components/AssistantLearnedReview";
import { TIDY_LAST_KEY, TIDY_SUMMARY_KEY } from "@/lib/assistantTidy";
import { isExpired } from "@/lib/assistantMemory";
import { formatDateTime } from "@/lib/format";
import { runSpeed } from "@/lib/assistantRun";
import { unlinkWhatsAppFor } from "@/app/actions/assistantWhatsApp";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { ASSISTANT_WHATSAPP_KEY, maskWaId, whatsappSwitchOn } from "@/lib/assistantWhatsAppRules";
import { actingOwnerTenantId } from "@/lib/actingScope";

/** Who has a WhatsApp linked — masked — so the owner can see it, even for someone who has since lost access. */
async function linkedPhones() {
  const tenantId = await actingOwnerTenantId().catch(() => null);
  if (!tenantId) return [];
  return basePrisma.assistantPhoneLink.findMany({
    where: { tenantId, waId: { not: null }, verifiedAt: { not: null } },
    orderBy: { verifiedAt: "asc" },
    select: { userId: true, waId: true },
  });
}

export const dynamic = "force-dynamic";

const TONE_LABELS: Record<Tone, string> = {
  warm: "Warm",
  direct: "Direct",
  formal: "Formal",
  playful: "Playful",
};

/** 👍/👎 counts by reason over the last `days` — never which answers or whose. */
function ratingsSince(days: number) {
  return prisma.assistantTurn.groupBy({
    by: ["feedback", "feedbackReason"],
    where: { feedback: { not: null }, createdAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    _count: { _all: true },
  });
}

/** The phases worth showing, in the order they happen (assistantRun timings). */
const SPEED_PHASES: [string, string][] = [
  ["firstText", "First words"],
  ["total", "Whole answer"],
  ["context", "Getting ready"],
  ["plan1", "Choosing lookups"],
  ["lookups1", "Looking up"],
  ["answerFirstText", "Writing (first words)"],
];

const FEEDBACK_REASON_LABELS: Record<string, string> = {
  wrong_facts: "Wrong facts",
  bad_advice: "Bad advice",
  misunderstood: "Didn't understand",
  other: "Other",
};

export default async function AssistantSettingsPage() {
  await requireTenantOwner();
  if (!(await isModuleEnabled("automation"))) notFound();
  const [profile, notes, staff, tidiedAt, tidySummary, whatsappOn, phones, ratings, speed, voiceOn] = await Promise.all([
    getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
    prisma.assistantNote.findMany({ orderBy: [{ status: "desc" }, { createdAt: "desc" }] }),
    listActingTenantStaff(),
    getSetting(TIDY_LAST_KEY),
    getSetting(TIDY_SUMMARY_KEY),
    getSetting(ASSISTANT_WHATSAPP_KEY).then(whatsappSwitchOn),
    linkedPhones(),
    // 👍/👎 over the last 30 days — counts and reasons only. The conversations
    // stay private to each person; the owner sees how DAX is doing, not what was asked.
    ratingsSince(30),
    runSpeed(7).catch(() => ({ runs: 0, medians: {} as Record<string, number> })),
    getSetting(ASSISTANT_VOICE_REPLIES_KEY).then(voiceRepliesSwitchOn),
  ]);
  const rated = (rating: string) => ratings.filter((r) => r.feedback === rating).reduce((n, r) => n + r._count._all, 0);
  const wrongBecause = ratings.filter((r) => r.feedback === "down" && r.feedbackReason);
  const nameOf = new Map(staff.map((s) => [s.id, s.name]));
  const contentOf = new Map(notes.map((n) => [n.id, n.content]));
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
    source: n.source,
    lastConfirmedAt: n.lastConfirmedAt,
    lastUsedAt: n.lastUsedAt,
    validUntil: n.validUntil,
    expired: isExpired(n.validUntil),
    conflictsWith: n.conflictsWithId ? contentOf.get(n.conflictsWithId) ?? null : null,
  }));
  const unreviewed = learned.filter((n) => n.status !== "approved").length;
  const expired = learned.filter((n) => n.expired).length;

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
        <input type="hidden" name="webSearchShown" value="1" />
        <label className="flex items-start gap-3 rounded-lg border border-border/60 p-3 text-sm">
          <input type="checkbox" name="webSearch" defaultChecked={profile.webSearch} className="mt-1 accent-primary" />
          <span>
            <span className="block font-medium">Let {profile.name} search the internet when it helps</span>
            <span className="block text-xs text-muted-foreground">
              For things your CRM can&apos;t know — prime rate, a model&apos;s specs, news. The search only ever sees the
              question that was asked, never your customers or records, and {profile.name} names its sources. Not used for
              scheduled questions.
            </span>
          </span>
        </label>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <SaveButton>Save</SaveButton>
        </div>
      </SaveForm>

      <section className="card mt-6 max-w-2xl space-y-2 p-5">
        <h2 className="text-base font-semibold">How {profile.name} is doing</h2>
        <p className="text-xs text-muted-foreground">
          What your team marked under {profile.name}&apos;s answers in the last 30 days. Only the totals — each person&apos;s
          conversations stay private to them.
        </p>
        {rated("up") + rated("down") === 0 ? (
          <p className="text-sm text-muted-foreground">No answers rated yet.</p>
        ) : (
          <>
            <p className="text-sm">👍 {rated("up")} useful · 👎 {rated("down")} wrong</p>
            {wrongBecause.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 text-xs">
                {wrongBecause.map((r) => (
                  <li key={r.feedbackReason} className="rounded-md border border-border/60 px-2 py-0.5">
                    {FEEDBACK_REASON_LABELS[r.feedbackReason ?? ""] ?? r.feedbackReason}: {r._count._all}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {/* Speed: the median of the last week's answers, per phase — so the slow part is found, not guessed. */}
        <div className="border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-muted-foreground">Speed, last 7 days ({speed.runs} answers)</p>
          {speed.runs === 0 ? (
            <p className="text-sm text-muted-foreground">No answers timed yet.</p>
          ) : (
            <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-3">
              {SPEED_PHASES.filter(([key]) => speed.medians[key] !== undefined).map(([key, label]) => (
                <li key={key} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="tabular-nums">{(speed.medians[key] / 1000).toFixed(1)} s</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <SaveForm action={saveAssistantWhatsAppCard} resetOnSuccess={false} className="card mt-6 max-w-2xl space-y-3 p-5">
        <h2 className="text-base font-semibold">{profile.name} on WhatsApp</h2>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={whatsappOn} className="mt-1 accent-primary" />
          <span>
            <span className="block font-medium">Let staff ask {profile.name} on WhatsApp</span>
            <span className="block text-xs text-muted-foreground">
              Each person can link their own WhatsApp on the Ask page — by sending a one-time code from that phone to
              the business number — and then ask {profile.name} by messaging the business number. Answers can contain
              customer details, and they go to that staff member&apos;s phone. On WhatsApp it only answers; tasks still
              need the CRM. Off: messages from staff phones are treated like any other, as today.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="voiceReplies"
            defaultChecked={voiceOn}
            className="mt-1 accent-primary"
          />
          <span>
            <span className="block font-medium">Let {profile.name} reply with voice notes</span>
            <span className="block text-xs text-muted-foreground">
              A voice note to {profile.name} gets a short spoken answer back as well as the full text, and answers in
              the CRM get a Listen button. English and Afrikaans only. Uses your ElevenLabs credit for every character
              spoken.
            </span>
          </span>
        </label>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <SaveButton>Save</SaveButton>
        </div>
      </SaveForm>
      {phones.length > 0 && (
        <div className="card max-w-3xl space-y-2 p-4 text-sm">
          <p className="font-medium">Phones linked to {profile.name}</p>
          <p className="text-xs text-muted-foreground">
            A link ends by itself when that person&apos;s password is reset or they&apos;re signed out everywhere. Unlink anything that shouldn&apos;t be here.
          </p>
          <ul className="divide-y divide-border/50">
            {phones.map((p) => (
              <li key={p.userId} className="flex items-center justify-between gap-3 py-2">
                <span>
                  {nameOf.get(p.userId) ?? "a former team member"} <span className="text-muted-foreground">({maskWaId(p.waId)})</span>
                </span>
                <ConfirmActionDialog
                  trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Unlink</button>}
                  title="Unlink this phone?"
                  description="Messages from it will be treated like any other number's. They can link again from the Ask page."
                  confirmLabel="Unlink"
                  destructive
                  onConfirm={unlinkWhatsAppFor.bind(null, p.userId)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Advanced: its soul, and everything it has learned — all editable. Open
          by default whenever there's something for the owner to look at. */}
      <details className="card mt-6 max-w-3xl p-5" open={Boolean(profile.soul) || unreviewed > 0 || expired > 0}>
        <summary className="cursor-pointer text-base font-semibold">
          Advanced — its soul and what it has learned
          {unreviewed > 0 && (
            <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
              {unreviewed} to review
            </span>
          )}
          {expired > 0 && (
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {expired} expired
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
            unreviewed; it never changes what you&apos;ve approved. If something it learns in a conversation contradicts
            what you&apos;ve approved, it holds the new entry back and asks you here which to keep. A rule for a while
            (&ldquo;for October…&rdquo;) stops being used after its last day and shows as expired.{" "}
            {tidiedAt ? `Last tidy-up ${formatDateTime(new Date(tidiedAt))}: ${tidySummary ?? "in progress"}.` : "It hasn't tidied yet."}
          </p>
          <AssistantLearnedReview notes={learned} />
        </div>
      </details>
    </SettingsWorkspace>
  );
}
