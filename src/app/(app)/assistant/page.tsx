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
import AssistantChat from "@/components/AssistantChat";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { deleteAssistantNote, saveMyAssistantNote } from "@/app/actions/assistantNotes";
import { deleteAssistantSchedule, setAssistantScheduleActive } from "@/app/actions/assistantSchedules";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { basePrisma, prisma } from "@/lib/db";
import { actingOwnerTenantId } from "@/lib/actingScope";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { assistantWhatsAppOn } from "@/lib/assistantWhatsApp";
import { maskWaId } from "@/lib/assistantWhatsAppRules";
import AssistantWhatsAppCard from "@/components/AssistantWhatsAppCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask the CRM" };

/**
 * The "on WhatsApp" card: only when the owner has switched it on and WhatsApp is
 * connected (the page above has already checked the person may use the
 * assistant). Null hides it. The person's own link, read by (workspace, person).
 */
async function whatsappCard(userId: string): Promise<{ linked: string | null } | null> {
  if (!(await assistantWhatsAppOn()) || !(await isWhatsAppConfigured())) return null;
  const tenantId = await actingOwnerTenantId().catch(() => null);
  if (!tenantId) return null;
  const link = await basePrisma.assistantPhoneLink.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { waId: true, verifiedAt: true },
  });
  return { linked: link?.waId && link.verifiedAt ? maskWaId(link.waId) : null };
}

export default async function AssistantPage() {
  const user = await requireAnyPermission(
    "leads.view_all", "leads.view_owned",
    "quotes.view_all", "quotes.view_owned",
    "activities.view", "activities.manage",
  );
  if (!(await isModuleEnabled("automation"))) notFound();
  const [connected, profile, history, aboutMe, schedules, whatsapp] = await Promise.all([
    isCodexConnected(),
    getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
    assistantHistory(user.id),
    prisma.assistantNote.findMany({ where: { kind: "profile", userId: user.id }, orderBy: { createdAt: "asc" }, select: { id: true, content: true } }),
    // This person's own schedules only.
    prisma.assistantSchedule.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, question: true, cadence: true, weekday: true, timeOfDay: true, onDate: true, nextRunAt: true, active: true },
    }),
    whatsappCard(user.id),
    // Being on this page is seeing them: the bubble's unread dot goes.
    markScheduledTurnsSeen(user.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={profile.name === "Assistant" ? "Ask the CRM" : `Ask ${profile.name}`}
        description="Your sales colleague: it reads your leads, quotes, activities and the business's own knowledge, and tells you what it means — never more than your own lists show you."
      />
      {connected ? (
        <AssistantChat name={profile.name} history={history.map(({ question, answer, source }) => ({ question, answer, source }))} />
      ) : (
        <p className="card p-5 text-sm text-muted-foreground">
          This runs on your workspace&apos;s ChatGPT connection, which isn&apos;t set up yet.{" "}
          <Link href="/settings/integrations" className="text-primary underline">Connect ChatGPT</Link> to start asking.
        </p>
      )}
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
      {whatsapp && <AssistantWhatsAppCard name={profile.name} linked={whatsapp.linked} />}
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
    </div>
  );
}
