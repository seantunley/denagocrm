import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { loadJourneyContext, type JourneyEntityType } from "./journeyContext";
import {
  enqueueJourneyRun,
  getActiveVersion,
  hashJourneyKey,
  jsonObject,
  REFUSAL_REASONS,
} from "./journeyEngineShared";
import { journeyTenantId } from "./journeyTenant";
import { decideTrigger, readJourneyTriggers } from "./journeyTriggers";
import { NEVER_STOP, type StopSignal } from "./stopSignal";

/** One event can enrol into several journeys, each of which may send. */
const EVENT_RESERVE_MS = 4_000;

/**
 * One journey's verdict on one event, as shown in the activity trace.
 *
 * `enrolled: false` is the interesting case and it has several distinct causes
 * — the reason string is what tells them apart, so never collapse them.
 */
export type JourneyEnrolmentDecision = {
  /**
   * The run this decision created, when it created one.
   *
   * Carried through so a caller can act on the EXACT run it caused. The manual
   * test run used to re-query "the newest run for this journey and lead", which
   * a concurrent enrolment can win — under run mode `parallel` especially,
   * where a second run is legal — so pressing "test" could report on, and
   * drive, somebody else's run.
   */
  runId?: string;
  journeyId: string;
  journeyName: string;
  enrolled: boolean;
  reason: string;
};

const MAX_EVENT_ATTEMPTS = 3;

export async function emitJourneyEvent(args: {
  type: string;
  entityType: JourneyEntityType;
  entityId: string;
  payload?: Record<string, unknown>;
  dedupeKey: string;
  journeyId?: string;
}) {
  try {
    return await prisma.journeyEvent.create({
      data: {
        // STAMPED, not left to the guard. With enforcement off the extension
        // writes nothing, so this row would land with a NULL tenantId — un-owned
        // by the workspace that raised it, and invisible to the strictly-equal
        // predicate every read below uses. Stamping it here is what makes the
        // queue's reads and writes agree in both modes.
        tenantId: journeyTenantId(),
        type: args.type,
        entityType: args.entityType,
        entityId: args.entityId,
        payload: (args.payload ?? {}) as Prisma.InputJsonValue,
        dedupeKey: hashJourneyKey(args.dedupeKey),
        journeyId: args.journeyId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

export async function recoverStaleJourneyEvents() {
  const tenantId = journeyTenantId();
  const cutoff = new Date(Date.now() - 15 * 60_000);
  return prisma.journeyEvent.updateMany({
    // A recovery that is not tenant-scoped is a cross-tenant WRITE: one slice
    // would hand every other workspace's in-flight events back to the queue,
    // and the tenant whose worker was mid-flight would see its own events
    // re-processed underneath it.
    where: { tenantId, status: "processing", updatedAt: { lt: cutoff } },
    data: { status: "pending", availableAt: new Date(), error: "Recovered stale processing event" },
  });
}

/**
 * Process ONE named event, and report what each journey decided.
 *
 * The manual-run action needs exactly this. It used to emit its event and then
 * call the global `processJourneyEvents(100)` / `processJourneyRuns(50)`, so
 * pressing "test" drove up to fifty unrelated due runs — real sends to real
 * customers who had nothing to do with the test. And when the backlog was
 * larger than those limits, the test's own event could still be sitting
 * pending while the action reported success.
 */
export async function processJourneyEventById(
  eventId: string,
): Promise<{ processed: boolean; enrolled: number; decisions: JourneyEnrolmentDecision[] }> {
  const tenantId = journeyTenantId();
  // Scoped by (id, tenantId), not fetched-then-checked. This is reachable from a
  // server action with an id from the request, so another workspace's event id
  // must resolve to nothing rather than to a row we then have to remember to
  // vet. findFirst because (id, tenantId) is not a unique index.
  const event = await prisma.journeyEvent.findFirst({ where: { id: eventId, tenantId } });
  if (!event) return { processed: false, enrolled: 0, decisions: [] };
  const result = await processOneEvent(tenantId, event);
  return { processed: result !== null, enrolled: result?.enrolled ?? 0, decisions: result?.decisions ?? [] };
}

export async function processJourneyEvents(limit = 50, stop: StopSignal = NEVER_STOP) {
  // ONE resolution for the whole pass, taken before the first query and threaded
  // into every event, so the batch this drains and the journeys it matches
  // against are the same tenant's by construction.
  const tenantId = journeyTenantId();
  const events = await prisma.journeyEvent.findMany({
    where: { tenantId, status: "pending", availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let enrolled = 0;

  for (const event of events) {
    if (stop.shouldStop(EVENT_RESERVE_MS)) break;
    const outcome = await processOneEvent(tenantId, event);
    enrolled += outcome?.enrolled ?? 0;
  }

  return { processed: events.length, enrolled };
}

/**
 * The body of the event loop, for one event. Returns null when another worker
 * claimed it first.
 */
async function processOneEvent(
  tenantId: string,
  event: { id: string; type: string; entityType: string; entityId: string; payload: Prisma.JsonValue | null; dedupeKey: string; journeyId: string | null },
): Promise<{ enrolled: number; decisions: JourneyEnrolmentDecision[] } | null> {
  let enrolled = 0;
  // Declared OUTSIDE the try, deliberately.
  //
  // Runs are committed one at a time as the loop goes; the event row is only
  // updated at the end. So a failure after some journeys have enrolled — the
  // final update, or anything else late — used to discard every decision made
  // so far and return a single "it failed" placeholder. The manual test run
  // then had no runId, reported that nothing happened, and the run it had
  // already created went on to execute and send. "Nothing was sent" while a
  // live run sends is the worst answer this function can give.
  //
  // Whatever was decided is a fact about work already committed, and survives
  // the failure that follows it.
  const decisions: JourneyEnrolmentDecision[] = [];
  {
    const claimed = await prisma.journeyEvent.updateMany({
      // The CLAIM carries the tenant too. It is the first write of the pass and
      // the one that decides who owns the work; unqualified, one slice could
      // claim — and so silently steal and re-attempt — another workspace's event.
      where: { id: event.id, tenantId, status: "pending" },
      data: { status: "processing", attempts: { increment: 1 }, error: null },
    });
    if (claimed.count === 0) return null;

    try {
      const journeys = await prisma.journey.findMany({
        where: {
          tenantId,
          status: "active",
          // `event.journeyId` NARROWS an already tenant-scoped set; it never
          // widens it. Scoping by tenant here rather than checking the journey
          // afterwards means a journeyId from another workspace matches nothing.
          ...(event.journeyId ? { id: event.journeyId } : {}),
        },
        include: { versions: { where: { tenantId, state: "published" } } },
      });
      const payload = jsonObject(event.payload);

      // `triggerId` IS AN INTERNAL SELECTION, NOT PART OF THE RUN CONTEXT.
      //
      // The scheduler puts a trigger's id on the event it raises so two
      // same-type triggers on one version — two `lead_idle` sweeps with
      // different idleDays — are attributed to the configuration that actually
      // fired, and decideTrigger honours that to pick between candidates. But
      // the payload is written by the event PRODUCER, and the run context is
      // published to journey conditions as `event.triggerId`.
      //
      // Copied straight through, those two roles collapse: an incoming
      // `triggerId` survived into the run context even when the matched trigger
      // was UNNAMED, so a step could branch on a name its own author never gave
      // anything — a condition field partly controlled by whoever raised the
      // event. So the two bags are separated here:
      //
      //   contextPayload — what JOURNEYS SEE. It is `event` in the run context
      //                    and the base of the run payload, and it never carries
      //                    an incoming triggerId. The published one is added
      //                    below from `verdict.matched.id` alone, i.e. only
      //                    where the author named the trigger that matched.
      //   eventPayload   — what the MATCHER judges, which is the same bag plus
      //                    the incoming selection. Internal, and never stored.
      const { triggerId: incoming, ...carried } = payload;
      const selection = typeof incoming === "string" ? incoming : null;
      const contextPayload = { ...carried, type: event.type };
      const eventPayload = selection ? { ...contextPayload, triggerId: selection } : contextPayload;

      // THE ENTITY IS RESOLVED WITHIN THIS TENANT BEFORE ITS CONTEXT IS LOADED.
      //
      // loadJourneyContext looks a lead/contact up by id alone, so with
      // enforcement off it will happily return another workspace's record —
      // whose name, email and phone then become the run context that the
      // messages are rendered from. Asking the tenant-scoped question first
      // means a foreign entityId is indistinguishable from a deleted one, which
      // is the outcome the caller already handles.
      const owned =
        event.entityType === "lead"
          ? await prisma.lead.findFirst({ where: { id: event.entityId, tenantId }, select: { id: true } })
          : await prisma.contact.findFirst({ where: { id: event.entityId, tenantId }, select: { id: true } });
      if (!owned) throw new Error("Journey event entity no longer exists");

      const context = await loadJourneyContext(
        event.entityType as JourneyEntityType,
        event.entityId,
        contextPayload
      );
      if (!context) throw new Error("Journey event entity no longer exists");

      // Every journey considered, and why it did or did not enrol. This loop
      // used to be bare `continue`s: a journey nobody emits for looked exactly
      // like a journey nobody matched, which is how "New lead created"
      // journeys sat active enrolling nobody with nothing on screen to say so.

      for (const journey of journeys) {
        const version = getActiveVersion(journey);
        if (!version) {
          decisions.push({ journeyId: journey.id, journeyName: journey.name, enrolled: false, reason: "no published version" });
          continue;
        }
        // ONE verdict for the whole trigger LIST, and it keeps the two refusals
        // apart: "this journey does not listen for that at all" and "it does,
        // but that trigger's own filter said no" are different answers to "why
        // was this customer not enrolled", and collapsing them is the defect
        // recording decisions exists to prevent.
        //
        // eventPayload, not just the context: a stage_entered event carries the
        // stage the lead ENTERED, and the cron drains up to 15 minutes later —
        // judging against the lead's stage now would silently match nothing for
        // anyone who moved the card again inside that window.
        const verdict = decideTrigger(
          readJourneyTriggers(version.triggers),
          event.type,
          context,
          eventPayload,
        );
        if (!verdict.matched) {
          decisions.push({ journeyId: journey.id, journeyName: journey.name, enrolled: false, reason: verdict.reason });
          continue;
        }
        const outcome = await enqueueJourneyRun({
          journey,
          version,
          entityType: event.entityType as JourneyEntityType,
          entityId: event.entityId,
          eventKey: event.dedupeKey,
          // WHICH trigger let this person in, published as `event.triggerId` so
          // a later step can branch on it. Only when the author named one —
          // every backfilled version, and every trigger nobody needed to
          // distinguish, leaves the field absent rather than inventing a value
          // a condition could accidentally match.
          //
          // Built on contextPayload, NOT eventPayload: the difference between
          // the two is exactly the incoming selection, and taking the wider bag
          // here is how the producer's `triggerId` used to survive an unnamed
          // match. `verdict.matched.id` is the only source of this field.
          payload: verdict.matched.id
            ? { ...contextPayload, triggerId: verdict.matched.id }
            : contextPayload,
        });
        if (outcome.enrolled) enrolled++;
        decisions.push({
          journeyId: journey.id,
          journeyName: journey.name,
          enrolled: outcome.enrolled,
          ...(outcome.enrolled ? { runId: outcome.runId } : {}),
          // Each refusal keeps its own words. These used to collapse to "already
          // enrolled for this event" — so a per-person cap refusal, a
          // single-mode drop and an entry-condition mismatch all read as the
          // idempotency key doing its job, i.e. as nothing being wrong.
          reason: outcome.enrolled
            ? outcome.status === "blocked"
              ? "queued behind an open run (run mode: queued)"
              : "enrolled"
            : REFUSAL_REASONS[outcome.refusal],
        });
      }

      // (id, tenantId) on every write back to the event, using Prisma's extended
      // unique where — so the pass can only ever settle the row it claimed, and
      // a foreign id raises P2025 instead of quietly recording someone else's
      // decisions on someone else's event.
      await prisma.journeyEvent.update({
        where: { id: event.id, tenantId },
        data: { status: "processed", processedAt: new Date(), decisions },
      });
      return { enrolled, decisions };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown journey event error";
      const current = await prisma.journeyEvent.findUnique({
        where: { id: event.id, tenantId },
        select: { attempts: true, availableAt: true },
      });
      const retry = (current?.attempts ?? MAX_EVENT_ATTEMPTS) < MAX_EVENT_ATTEMPTS;
      await prisma.journeyEvent.update({
        where: { id: event.id, tenantId },
        data: {
          status: retry ? "pending" : "failed",
          availableAt: retry ? new Date(Date.now() + 5 * 60_000) : current?.availableAt,
          error: message.slice(0, 1000),
        },
      });
      // Everything decided before the failure is KEPT, and the failure is
      // appended as one more line rather than replacing them. A caller that
      // enrolled successfully still gets its runId, so it can report — and act
      // on — the run that actually exists.
      // Everything decided before the failure is KEPT, and the failure is
      // appended as one more line rather than replacing them. A caller that
      // enrolled successfully still gets its runId, so it can report — and act
      // on — the run that actually exists.
      decisions.push({
        journeyId: "",
        journeyName: "—",
        enrolled: false,
        reason: `Event processing failed after ${decisions.filter((d) => d.enrolled).length} enrolment(s): ${message}`.slice(0, 300),
      });
      return { enrolled, decisions };
    }
  }
}
