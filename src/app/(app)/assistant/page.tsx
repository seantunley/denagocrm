import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isCodexConnected } from "@/lib/codex";
import { getSetting } from "@/lib/settings";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import { assistantHistory } from "@/lib/crmAssistant";
import { markScheduledTurnsSeen } from "@/lib/assistantScheduleRun";
import { describeSchedule } from "@/lib/assistantSchedule";
import { isExpired } from "@/lib/assistantMemory";
import { assistantVoiceRepliesOn } from "@/lib/assistantVoice";
import AssistantChat from "@/components/AssistantChat";
import SavedAssistantCards from "@/components/SavedAssistantCards";
import type { ActionCard } from "@/lib/assistantActions";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { deleteAssistantNote, saveMyAssistantNote } from "@/app/actions/assistantNotes";
import { deleteAssistantSchedule, setAssistantScheduleActive } from "@/app/actions/assistantSchedules";
import EditScheduleDialog from "@/components/EditScheduleDialog";
import { deleteAssistantWatch, setAssistantWatchActive } from "@/app/actions/assistantWatches";
import { ONE_SHOT_KINDS, type WatchKind } from "@/lib/assistantWatchRules";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { basePrisma, prisma } from "@/lib/db";
import { actingOwnerTenantId } from "@/lib/actingScope";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { assistantWhatsAppOn } from "@/lib/assistantWhatsApp";
import { linkRefusalText, maskWaId } from "@/lib/assistantWhatsAppRules";
import AssistantWhatsAppCard from "@/components/AssistantWhatsAppCard";
import AssistantProactiveCard from "@/components/AssistantProactiveCard";
import { ASSISTANT_PROACTIVE_KEY, proactiveOn, proactivePersonKey } from "@/lib/proactiveRules";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask the CRM" };

/**
 * The "on WhatsApp" card: only when the owner has switched it on and WhatsApp is
 * connected (the page above has already checked the person may use the
 * assistant). Null hides it. The person's own link, read by (workspace, person).
 */
async function whatsappCard(userId: string): Promise<{ linked: string | null; refused: string | null; updates: boolean } | null> {
  if (!(await assistantWhatsAppOn()) || !(await isWhatsAppConfigured())) return null;
  const tenantId = await actingOwnerTenantId().catch(() => null);
  if (!tenantId) return null;
  const link = await basePrisma.assistantPhoneLink.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { waId: true, verifiedAt: true, refusedReason: true, updatesOnWhatsApp: true },
  });
  return { linked: link?.waId && link.verifiedAt ? maskWaId(link.waId) : null, refused: linkRefusalText(link?.refusedReason), updates: link?.updatesOnWhatsApp ?? true };
}

export default async function AssistantPage() {
  const user = await requireAnyPermission(
    "leads.view_all", "leads.view_owned",
    "quotes.view_all", "quotes.view_owned",
    "activities.view", "activities.manage",
  );
  if (!(await isModuleEnabled("automation"))) notFound();
  const [listen, connected, profile, history, aboutMe, schedules, whatsapp, watches, saved] = await Promise.all([
    assistantVoiceRepliesOn().catch(() => false),
    isCodexConnected(),
    getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
    assistantHistory(user.id),
    prisma.assistantNote.findMany({ where: { kind: "profile", userId: user.id }, orderBy: { createdAt: "asc" }, select: { id: true, content: true, status: true, validUntil: true } }),
    // This person's own schedules only.
    prisma.assistantSchedule.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, question: true, cadence: true, weekday: true, timeOfDay: true, onDate: true, nextRunAt: true, active: true },
    }),
    whatsappCard(user.id),
    // This person's own watches only — every one of them, running or not.
    prisma.assistantWatch.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, label: true, active: true, lastFiredAt: true },
    }),
    // Tasks this person asked for on WhatsApp that are only done here, still
    // waiting: their own, not confirmed, not failed, not expired.
    prisma.assistantPendingAction.findMany({
      where: { userId: user.id, forCrm: true, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, card: true, createdAt: true },
    }),
    // Being on this page is seeing them: the bubble's unread dot goes.
    markScheduledTurnsSeen(user.id),
  ]);
  // Proactive DAX: the owner's switch for the workspace, and this person's own (lib/proactive.ts).
  const [proactiveWorkspace, proactiveMe] = await Promise.all([
    getSetting(ASSISTANT_PROACTIVE_KEY).then(proactiveOn).catch(() => false),
    getSetting(proactivePersonKey(user.id)).then(proactiveOn).catch(() => false),
  ]);
  // What was stored is a card the assistant proposed; anything that is not shaped like one is left out, not rendered.
  const savedCards = saved.flatMap((row) => {
    const card = row.card as ActionCard | null;
    return card && typeof card === "object" && typeof card.kind === "string" && typeof card.title === "string" ? [{ id: row.id, card }] : [];
  });
  const saWhen = (d: Date) =>
    d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    // FULL WIDTH, like every other page: no centred column with empty gutters.
    // On a wide screen the conversation takes the room and everything you manage
    // (scheduled, watching, your phone, what it knows about you) sits beside it,
    // so none of it is below a long conversation. Narrower, the same order stacks.
    //
    // SIDE BY SIDE ONLY FROM 2xl (1536px). The app's own sidebar takes ~260px, so
    // at 1280px or 1440px a side column would leave the conversation 528px or
    // 688px — narrower than the 768px column this replaced. Below 2xl the
    // conversation keeps the whole width and the rest goes under it.
    <div className="space-y-6">
      <PageHeader
        title={profile.name === "Assistant" ? "Ask the CRM" : `Ask ${profile.name}`}
        description="Your sales colleague: it reads your leads, quotes, activities and the business's own knowledge, and tells you what it means — never more than your own lists show you."
      />
      <div className="grid items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]">
      <div className="min-w-0 space-y-6">
      {/* What is waiting on you comes first, above the conversation. Always rendered: it holds the
          list this visit started with, and shows nothing when that was empty. */}
      <SavedAssistantCards name={profile.name} cards={savedCards} />
      {connected ? (
        <AssistantChat name={profile.name} history={history.map(({ question, answer, source }) => ({ question, answer, source }))} listen={listen} />
      ) : (
        <p className="card p-5 text-sm text-muted-foreground">
          This runs on your workspace&apos;s ChatGPT connection, which isn&apos;t set up yet.{" "}
          <Link href="/settings/integrations" className="text-primary underline">Connect ChatGPT</Link> to start asking.
        </p>
      )}
      </div>
      <aside className="min-w-0 space-y-6">
      <section className="card space-y-3 p-4 text-sm">
        <h2 className="font-medium">⏰ Scheduled</h2>
        {schedules.length === 0 ? (
          <p className="text-muted-foreground">
            Ask {profile.name} to look into something on a schedule — e.g. &ldquo;every Monday at 7, tell me which deals went quiet&rdquo;. You confirm it first; it runs as you, on the hour or half past (a time like 07:10 is set to 07:00).
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {schedules.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{describeSchedule(s)}</p>
                  <p className="text-muted-foreground">{s.question}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.active && s.nextRunAt
                      ? `Next: ${s.nextRunAt.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                      : "Paused"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-3">
                  <EditScheduleDialog schedule={{ id: s.id, question: s.question, cadence: s.cadence, weekday: s.weekday, timeOfDay: s.timeOfDay, onDate: s.onDate }} />
                  <ConfirmActionDialog
                    trigger={<button type="button" className="text-xs text-muted-foreground hover:text-foreground">{s.active ? "Pause" : "Resume"}</button>}
                    title={s.active ? "Pause this?" : "Resume this?"}
                    description={s.active ? "It won't run until you resume it." : "It runs from its next time — missed runs aren't made up."}
                    confirmLabel={s.active ? "Pause" : "Resume"}
                    onConfirm={setAssistantScheduleActive.bind(null, s.id, !s.active)}
                  />
                  <ConfirmActionDialog
                    trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Delete</button>}
                    title="Delete this scheduled question?"
                    description="It won't run again. Answers it already gave stay in your history."
                    confirmLabel="Delete"
                    destructive
                    onConfirm={deleteAssistantSchedule.bind(null, s.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card space-y-3 p-4 text-sm">
        <h2 className="font-medium">👀 Watching</h2>
        <p className="text-muted-foreground">
          Ask {profile.name} to keep an eye on something — e.g. &ldquo;tell me when Anna opens her quote&rdquo; or &ldquo;tell me if a lead goes a week without contact&rdquo;. You confirm it first; it checks every half hour and only ever tells you — it never contacts a customer.
        </p>
        {watches.length > 0 && (
          <ul className="divide-y divide-border/50">
            {watches.map((w) => {
              const done = !w.active && Boolean(w.lastFiredAt) && ONE_SHOT_KINDS.includes(w.kind as WatchKind);
              return (
                <li key={w.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">{w.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {done ? "Done" : w.active ? "Watching" : "Paused"}
                      {w.lastFiredAt ? ` · last told you ${saWhen(w.lastFiredAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-3">
                    {!done && (
                      <ConfirmActionDialog
                        trigger={<button type="button" className="text-xs text-muted-foreground hover:text-foreground">{w.active ? "Pause" : "Resume"}</button>}
                        title={w.active ? "Pause this watch?" : "Resume this watch?"}
                        description={w.active ? "It won't check or tell you anything until you resume it." : "It starts checking again at the next half hour."}
                        confirmLabel={w.active ? "Pause" : "Resume"}
                        onConfirm={setAssistantWatchActive.bind(null, w.id, !w.active)}
                      />
                    )}
                    <ConfirmActionDialog
                      trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Delete</button>}
                      title="Delete this watch?"
                      description="It won't check again. What it already told you stays in your history."
                      confirmLabel="Delete"
                      destructive
                      onConfirm={deleteAssistantWatch.bind(null, w.id)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <AssistantProactiveCard name={profile.name} workspaceOn={proactiveWorkspace} on={proactiveMe} />
      {whatsapp &&<AssistantWhatsAppCard name={profile.name} linked={whatsapp.linked} refused={whatsapp.refused} updates={whatsapp.updates} />}
      <details className="card p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          About you — what {profile.name} knows{aboutMe.length ? ` (${aboutMe.length})` : ""}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Used only in your own conversations. {profile.name} adds to this as it learns how you work; you can add, correct or remove anything.
        </p>
        <ul className="mt-3 divide-y divide-border/50">
          {aboutMe.map((note) => (
            <li key={note.id} className="space-y-2 py-2">
              <p className="whitespace-pre-line">{note.content}</p>
              {/* Shown, not hidden: one DAX isn't using right now, and why. */}
              {note.status === "conflict" && (
                <p className="text-[11px] text-muted-foreground">On hold — it contradicts something the workspace owner approved; they&apos;ll decide which stands.</p>
              )}
              {isExpired(note.validUntil) && <p className="text-[11px] text-muted-foreground">Ended — no longer used.</p>}
              <div className="flex flex-wrap items-center gap-2">
                <details className="w-full text-xs sm:w-auto">
                  <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground">Edit</summary>
                  <SaveForm action={saveMyAssistantNote.bind(null, note.id)} resetOnSuccess={false} className="mt-2 space-y-2">
                    <textarea name="content" defaultValue={note.content} rows={2} maxLength={400} className="input w-full" />
                    <SaveButton className="btn-primary btn-sm">Save</SaveButton>
                  </SaveForm>
                </details>
                <ConfirmActionDialog
                  trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Forget</button>}
                  title="Forget this?"
                  description="It will stop using it in your conversations."
                  confirmLabel="Forget"
                  destructive
                  onConfirm={deleteAssistantNote.bind(null, note.id)}
                />
              </div>
            </li>
          ))}
        </ul>
        <SaveForm action={saveMyAssistantNote.bind(null, null)} className="mt-3 space-y-2">
          <textarea
            name="content"
            rows={2}
            maxLength={400}
            className="input w-full"
            placeholder="e.g. I look after fleet and golf-estate deals in Gauteng. Short answers with bullet points, please."
          />
          <SaveButton className="btn-secondary btn-sm">Tell {profile.name}</SaveButton>
        </SaveForm>
      </details>
      </aside>
      </div>
    </div>
  );
}
