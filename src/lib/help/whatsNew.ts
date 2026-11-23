/**
 * "What's new" in the help centre (2026-11-23): a short, dated list of changes
 * staff would notice, newest first. The CRM ships often and nobody was told.
 *
 * WRITTEN BY HAND, in the pull request that ships the change — add an entry at
 * the TOP when a change is something a person using the CRM would see. Not a
 * changelog: fixes, refactors and anything invisible stay out. Say what someone
 * can now do, in a sentence or two, and link to the screen or the guide.
 *
 * `module` hides an entry from a workspace without that module; `ownerOnly`
 * from everyone but the workspace owner. Pure data and pure functions; where
 * "seen" is kept is lib/help/whatsNewSeen.ts.
 */
export type WhatsNewEntry = {
  /** Stable and unique: it is what "seen" remembers. Never reuse or rename one. */
  id: string;
  /** The day it reached everyone, YYYY-MM-DD. */
  date: string;
  title: string;
  text: string;
  /** Where to try it or read more: an app path. */
  href?: string;
  hrefLabel?: string;
  module?: string;
  ownerOnly?: boolean;
};

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-11-vehicle-photo-scan",
    date: "2026-11-23",
    title: "Scan a VIN or registration from a photo",
    text: "On the vehicle form, Scan from a photo reads the VIN plate, licence disc or number plate and offers the details for you to check and accept. The photo is read once and not kept.",
    href: "/vehicles/new",
    hrefLabel: "Add a vehicle",
    module: "automotive",
  },
  {
    id: "2026-11-unusual-activity-email",
    date: "2026-11-23",
    title: "A weekly email of what moved that nobody asked about",
    text: "Off until you switch it on: a Monday email when a model's warranty claims jump, someone's first replies on help desk tickets slow down, or a quote goes out with an unusually large discount. A quiet week sends nothing.",
    href: "/settings/automatic",
    hrefLabel: "Automatic jobs & messages",
    ownerOnly: true,
  },
  {
    id: "2026-11-subtle-depth",
    date: "2026-11-23",
    title: "A little more depth",
    text: "Cards sit slightly raised, buttons press, and a card you drag on the pipeline lifts while the column under it dips. Nothing moves if your device is set to reduce motion.",
  },
  {
    id: "2026-11-vehicle-transfer",
    date: "2026-11-21",
    title: "Transfer a vehicle and its warranty to a new owner",
    text: "A change of owner is now a transfer with a record: the vehicle's history stays with it and the ownership history shows who had it when.",
    href: "/help/vehicle-transfer",
    hrefLabel: "Read the guide",
    module: "automotive",
  },
  {
    id: "2026-11-copy-my-signature",
    date: "2026-11-20",
    title: "Copy your email signature for Gmail, Outlook or your phone",
    text: "Copy my signature gives you the CRM's signature to paste into another mail app, with steps for each, so emails sent outside the CRM match.",
    href: "/email-signatures",
    hrefLabel: "Email signatures",
  },
];

export type WhatsNewReader = { owner: boolean; modules: ReadonlySet<string> | null };

/** The entries this person should see, newest first. `modules: null` = unknown, so only entries tied to no module. */
export function whatsNewFor(entries: readonly WhatsNewEntry[], reader: WhatsNewReader): WhatsNewEntry[] {
  return entries
    .filter((entry) => (!entry.ownerOnly || reader.owner) && (!entry.module || (reader.modules?.has(entry.module) ?? false)))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** How many of these the person has not seen yet. */
export function unseenCount(entries: readonly WhatsNewEntry[], seen: ReadonlySet<string>): number {
  return entries.filter((entry) => !seen.has(entry.id)).length;
}

const ID = /^[a-z0-9-]{3,80}$/;
export const MAX_SEEN = 300;

/** The stored text as a set of entry ids; anything else reads as nothing seen. */
export function parseSeen(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === "string" && ID.test(item)).slice(-MAX_SEEN)) : new Set();
  } catch {
    return new Set();
  }
}

/** The stored text with these ids seen as well — or null when nothing would change. */
export function withSeen(raw: string | null | undefined, ids: readonly string[]): string | null {
  const seen = parseSeen(raw);
  const before = seen.size;
  for (const id of ids) if (ID.test(id)) seen.add(id);
  return seen.size === before ? null : JSON.stringify([...seen].slice(-MAX_SEEN));
}

/** "23 November 2026" from "2026-11-23", with no time zone to get wrong. */
export function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return months[month - 1] && day ? `${day} ${months[month - 1]} ${year}` : date;
}
