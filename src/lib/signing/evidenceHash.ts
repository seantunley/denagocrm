import crypto from "crypto";

/**
 * The evidence chain's hash format, deliberately free of any server binding.
 *
 * This file imports nothing but `crypto` — no `server-only`, no database, no
 * Next runtime — because verifying evidence must not require the system that
 * produced it. Anyone handed an evidence export should be able to recompute
 * these hashes with this file alone, which is what makes the chain worth
 * anything in a dispute. It is also why the logic is here rather than inside
 * `events.ts`, which is server-bound and cannot even be imported by a test.
 */

/**
 * Canonical JSON: object keys sorted at every level, so the same content always
 * produces the same string.
 *
 * This is what makes the chain verifiable rather than merely computed. Event
 * metadata is stored as `jsonb`, and jsonb does not preserve the key order it
 * was given — it orders keys by length and then bytewise. A digest taken over
 * `JSON.stringify(metadata)` at write time would therefore disagree with one
 * taken over the same row read back, and every event would look tampered with.
 * Sorting on both sides removes PostgreSQL's ordering from the question.
 *
 * Array order is preserved, because in an array order is meaning rather than
 * formatting.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export type SignEventInput = {
  id: string;
  requestId: string;
  recipientId: string | null;
  type: string;
  actor: string;
  channel: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
};

/**
 * The content digest of one evidence row.
 *
 * Deliberately does NOT include `sequence` or `tenantId`. Both are assigned by
 * the database — the sequence by the chaining trigger, the tenant by the
 * stamping trigger — so an application hashing them would be hashing values it
 * had guessed. Neither is left unprotected: position is covered by the chain
 * itself and by a unique index, and the owning tenant is a property of the
 * request the event names.
 *
 * The field order and the `|` separator are PART OF THE FORMAT. Changing either
 * invalidates every hash written before the change, so this function is the
 * definition of the format, not an implementation detail of it.
 */
export function signEventPayloadHash(input: SignEventInput): string {
  const payload = [
    input.id,
    input.requestId,
    input.recipientId ?? "",
    input.type,
    input.actor,
    input.channel ?? "",
    input.ip ?? "",
    input.userAgent ?? "",
    canonicalJson(input.metadata ?? {}),
    input.createdAt.toISOString(),
  ].join("|");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/** How one row links to the one before it. The chain's only other rule. */
export function signEventLinkHash(prevHash: string, payloadHash: string): string {
  return crypto.createHash("sha256").update(`${prevHash}${payloadHash}`, "utf8").digest("hex");
}

/** The prevHash of the first event in a request's chain. */
export const EVIDENCE_CHAIN_ROOT = "0".repeat(64);

/**
 * Verify a request's evidence in the order the database returns it.
 *
 * Returns the first break rather than a boolean: "event 4 of 9 does not follow
 * from event 3" is actionable, "false" is not.
 *
 * Events written before the chain existed carry a sentinel content hash (the
 * migration could not attest to rows that were freely editable until it ran), so
 * their LINKS still verify while their contents are not claimed to. That is the
 * honest boundary and this reports it rather than hiding it.
 */
export function verifyEvidenceChain(
  events: Array<
    Pick<SignEventInput, "id"> & {
      sequence: number; prevHash: string; payloadHash: string; eventHash: string;
    } & Partial<SignEventInput>
  >,
): { ok: true } | { ok: false; brokenAt: string; reason: string } {
  let expectedPrev = EVIDENCE_CHAIN_ROOT;
  let expectedSequence = 1;
  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      return { ok: false, brokenAt: event.id, reason: `expected sequence ${expectedSequence}, found ${event.sequence}` };
    }
    if (event.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: event.id, reason: "does not follow the preceding event" };
    }
    if (signEventLinkHash(event.prevHash, event.payloadHash) !== event.eventHash) {
      return { ok: false, brokenAt: event.id, reason: "link hash does not match its own contents" };
    }
    // RECOMPUTE the content hash when the row's fields are present.
    //
    // Checking only prevHash+payloadHash=eventHash verifies that the chain is
    // internally consistent, which an editor who also recomputed the hashes
    // would satisfy. It does NOT detect an edited actor, type, timestamp or
    // metadata behind an unchanged payloadHash — so a bundle carrying the event
    // contents must be checked against them.
    //
    // Skipped only for rows that predate the chain, whose payloadHash is a
    // documented sentinel rather than a digest of anything.
    if (event.requestId && event.type && event.createdAt && !isHistoricSentinel(event)) {
      const recomputed = signEventPayloadHash({
        id: event.id,
        requestId: event.requestId,
        recipientId: event.recipientId ?? null,
        type: event.type,
        actor: event.actor ?? "",
        channel: event.channel ?? null,
        ip: event.ip ?? null,
        userAgent: event.userAgent ?? null,
        metadata: event.metadata ?? {},
        createdAt: event.createdAt instanceof Date ? event.createdAt : new Date(event.createdAt),
      });
      if (recomputed !== event.payloadHash) {
        return { ok: false, brokenAt: event.id, reason: "event contents do not match their recorded hash" };
      }
    }
    expectedPrev = event.eventHash;
    expectedSequence += 1;
  }
  return { ok: true };
}

/** Rows chained by the migration carry `historic-event:<id>` rather than a content digest. */
function isHistoricSentinel(event: { id: string; payloadHash: string }): boolean {
  return event.payloadHash === crypto.createHash("sha256").update(`historic-event:${event.id}`, "utf8").digest("hex");
}
