/**
 * @mentions and watching — the pure half (the database half is collaboration.ts). No imports from the server, so the
 * mention box and the tests use the same rules.
 */

export type RecordType = "lead" | "contact" | "jobcard" | "conversation";
export type WatchableType = Exclude<RecordType, "conversation">;
export const WATCHABLE: readonly WatchableType[] = ["lead", "contact", "jobcard"];
export type WatchEvent = "note" | "stage" | "reply" | "status";

const SNIPPET_MAX = 160;

/**
 * Who a note actually names: of the people picked from the @ list, those whose "@Name" is still in the text (picking
 * someone and then deleting their name un-mentions them), and only staff of this workspace — an id typed by hand
 * names nobody.
 */
export function mentionedIds(text: string, picked: readonly string[], staff: readonly { id: string; name: string }[]): string[] {
  const byId = new Map(staff.map((person) => [person.id, person.name]));
  return [...new Set(picked)].filter((id) => {
    const name = byId.get(id);
    return Boolean(name) && text.includes(`@${name}`);
  });
}

/** The @ being typed at the cursor ("Hi @tha" → "tha"), or null when the cursor isn't in one. */
export function mentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > 30 || /[\n@]/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}

/** The first words of a note, on one line, for the bell. */
export function snippetOf(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat;
}

export function recordHref(type: RecordType, id: string): string {
  if (type === "lead") return `/leads/${id}`;
  if (type === "contact") return `/contacts/${id}`;
  if (type === "jobcard") return `/jobcards/${id}`;
  return `/inbox?c=${id}`;
}

export function mentionTitle(actorName: string, label: string): string {
  return `${actorName} mentioned you on ${label}`;
}

export function watchTitle(event: WatchEvent, label: string, detail?: string | null): string {
  if (event === "note") return `New note on ${label}`;
  if (event === "reply") return `${label} replied`;
  if (event === "stage") return `${label} moved${detail ? ` to ${detail}` : ""}`;
  return `${label}: ${detail ?? "status changed"}`;
}

/** A phone notification names no customer — it can show on a locked screen. */
export function pushFor(kind: "mention" | "watch", actorName: string | null): { title: string; body: string } {
  return kind === "mention"
    ? { title: `${actorName ?? "Someone"} mentioned you`, body: "Tap to read it in the CRM." }
    : { title: "Update on a record you watch", body: "Tap to see what changed." };
}

/**
 * The record a watch notification is ABOUT: the deal when the event came from one (a note, reply or stage change on a
 * deal is the deal's, even to its customer's watchers), else the first record given. Null when none is.
 */
export function watchOrigin<T extends { type: WatchableType; id: string | null | undefined }>(refs: readonly T[]): { type: WatchableType; id: string } | null {
  const lead = refs.find((ref) => ref.type === "lead" && ref.id);
  const first = lead ?? refs.find((ref) => ref.id);
  return first?.id ? { type: first.type, id: first.id } : null;
}

export const isWatchable =(type: string): type is WatchableType => (WATCHABLE as readonly string[]).includes(type);
