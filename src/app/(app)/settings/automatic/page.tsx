import Link from "next/link";
import { requireTenantOwner } from "@/lib/auth";
import { SettingsWorkspace, SettingsSection } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { AUTOMATIONS, type Automation, type AutomationReach } from "@/lib/automationRegister";
import { readAutomationSwitches, readReadyMadeJourneys } from "@/app/actions/automationSettings";
import { SIGNING_EMAILS, type SigningEmailKind } from "@/lib/signing/emailTemplates";
import { AutomationSwitch } from "./AutomationSwitch";
import { messageEditorHref } from "@/lib/customerMessagePlaces";

export const dynamic = "force-dynamic";

// No icons: SettingsSection is a client component, and an icon component can't
// cross from this server page to it.
const GROUPS: { reach: AutomationReach; title: string; description: string }[] = [
  {
    reach: "customer",
    title: "Other messages to customers",
    description:
      "Not automatic journeys: each is part of something a person sent, or switched on for that one item — and says where.",
  },
  { reach: "staff", title: "Notifies your team", description: "Messages and notifications to the people in this workspace only." },
  { reach: "nobody", title: "Housekeeping", description: "Background work that sends nothing to anyone." },
];

/** Each message opens in its editor, wherever it lives (lib/customerMessagePlaces.ts), to read and change. */
function MessageLinks({ kinds }: { kinds: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-xs">
      {kinds.map((kind) => {
        const def = SIGNING_EMAILS[kind as SigningEmailKind];
        return def ? (
          <li key={kind}>
            <Link href={messageEditorHref(kind as SigningEmailKind)} className="text-primary underline">
              {def.label.replace(/ \((email|SMS|WhatsApp)\)$/, "")} ({def.channel === "sms" ? "SMS" : def.channel === "whatsapp" ? "WhatsApp" : "email"}) — view / edit
            </Link>
          </li>
        ) : null;
      })}
    </ul>
  );
}

function journeyState(status: string | null): { text: string; className: string } {
  if (status === "active") return { text: "On", className: "font-medium text-emerald-500" };
  if (status === null) return { text: "Deleted", className: "text-muted-foreground" };
  if (status === "archived") return { text: "Archived", className: "text-muted-foreground" };
  return { text: "Off", className: "text-muted-foreground" };
}

/**
 * EVERYTHING the CRM does by itself, in one place (automationRegister.ts).
 * Nothing runs that isn't on this page — tests/automationRegister.test.ts fails
 * the build if a background job or automatic message is added without it.
 *
 * Automatic customer messages are journeys (one engine, 2026-10-06): listed
 * first, each with its state and a link to switch or edit it on Journeys.
 */
export default async function AutomaticJobsPage() {
  await requireTenantOwner();
  const [switches, readyMade] = await Promise.all([readAutomationSwitches(), readReadyMadeJourneys()]);
  const engine = AUTOMATIONS.find((a) => a.key === "journeys")!;

  const row = (a: Automation) => (
    <li key={a.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{a.label}</p>
        <p className="text-sm text-muted-foreground">{a.does}</p>
        {a.notJourney && <p className="text-xs text-muted-foreground">Not a journey: {a.notJourney}</p>}
        <p className="text-xs text-muted-foreground">
          {a.when}
          {a.channels?.length ? ` · ${a.channels.join(", ")}` : ""}
        </p>
        {/* What it actually sends — each message opens in its editor, to read and change. */}
        {a.messages?.length ? (
          <MessageLinks kinds={a.messages} />
        ) : a.messagesAt ? (
          <p className="pt-1 text-xs">
            <Link href={a.messagesAt.href} className="text-primary underline">
              The wording is written on {a.messagesAt.label} — view / edit
            </Link>
          </p>
        ) : null}
      </div>
      <div className="shrink-0 sm:pl-4">
        {a.setting ? (
          <AutomationSwitch settingKey={a.setting.key} initial={switches[a.setting.key] ?? a.setting.defaultOn} label={a.label} />
        ) : a.managedAt ? (
          <Link href={a.managedAt.href} className="text-sm text-primary underline">
            Set up in {a.managedAt.label}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">Always on</span>
        )}
        {a.setting && a.managedAt && (
          <Link href={a.managedAt.href} className="mt-1 block text-xs text-muted-foreground underline">
            Details in {a.managedAt.label}
          </Link>
        )}
      </div>
    </li>
  );

  return (
    <SettingsWorkspace
      current="automatic"
      title="Automatic jobs & messages"
      description="Everything the CRM does on its own — what it sends, to whom, and when — with the switch for each. If it isn't on this page, it doesn't run."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-6">
        <SettingsSection
          title="Customer messages are journeys"
          description="Every message the CRM sends a customer by itself is a journey — the ready-made ones below and any you build. Each is off until you switch it on, and you can change its trigger, timing and steps."
        >
          {!readyMade.marketingOn && (
            <p role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-300">
              Journeys run only with the Marketing pack, which is off for this workspace — so none of these send
              anything, even when on.
            </p>
          )}
          <ul className="divide-y divide-border/50">
            {readyMade.rows.map((journey) => {
              const state = journeyState(journey.status);
              return (
                <li key={journey.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">
                      {journey.name} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">Ready-made journey</span>
                    </p>
                    <p className="text-sm text-muted-foreground">{journey.description}</p>
                    <p className="text-xs text-muted-foreground">{journey.channels.join(", ")}</p>
                    <MessageLinks kinds={journey.messages} />
                  </div>
                  <div className="shrink-0 space-y-1 sm:pl-4 sm:text-right">
                    <p className={`text-sm ${state.className}`} aria-label={`${journey.name}: ${state.text}`}>{state.text}</p>
                    <Link href="/journeys" className="block text-xs text-primary underline">
                      {journey.status === "active" ? "Switch off or edit in Journeys" : "Switch on or edit in Journeys"}
                    </Link>
                  </div>
                </li>
              );
            })}
            {row(engine)}
          </ul>
        </SettingsSection>
        {GROUPS.map((group) => (
          <SettingsSection key={group.reach} title={group.title} description={group.description}>
            <ul className="divide-y divide-border/50">
              {AUTOMATIONS.filter((a) => a.reaches === group.reach && a.key !== engine.key).map(row)}
            </ul>
          </SettingsSection>
        ))}
        <p className="text-sm text-muted-foreground">
          How the background work is doing — what&apos;s queued, stuck or failed — is on{" "}
          <Link href="/settings/queues" className="text-primary underline">Background queues</Link>.
        </p>
      </div>
    </SettingsWorkspace>
  );
}
