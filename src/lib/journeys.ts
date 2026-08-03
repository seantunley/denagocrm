import { NEVER_STOP, type StopSignal } from "./stopSignal";
import {
  processJourneyEvents,
  recoverStaleJourneyEvents,
} from "./journeyEvents";
import {
  processJourneyRuns,
  recoverStaleJourneyRuns,
  releaseBlockedJourneyRuns,
} from "./journeyRuns";
// enrollJourneyNow was imported here and never called — line 17 re-exports it
// from the same module, which is what callers actually use.
import { runScheduledJourneyEnrollments } from "./journeyScheduling";
import { pruneJourneyTraces } from "./journeyRetention";

export { emitJourneyEvent, processJourneyEventById, processJourneyEvents } from "./journeyEvents";
export { processJourneyRuns, processOneRun } from "./journeyRuns";
export { enrollJourneyNow, runScheduledJourneyEnrollments } from "./journeyScheduling";

/**
 * `stop` is how the caller bounds this. The engine schedules up to 1000 records,
 * processes 50 events and 40 runs of up to 20 steps each — all sequentially — so
 * a fixed "is there probably enough time?" check before starting is not a bound
 * at all. It sends email and WhatsApp, so being killed partway through is a
 * half-delivered campaign rather than a retryable no-op.
 *
 * Every phase and every unit inside it checks the signal, and everything it
 * leaves undone is picked up by the next tick.
 */
export async function runJourneyEngine(stop: StopSignal = NEVER_STOP) {
  const [recoveredEvents, recoveredRuns] = await Promise.all([
    recoverStaleJourneyEvents(),
    recoverStaleJourneyRuns(),
  ]);
  // Before processing: a run parked behind a predecessor that has since closed
  // must be handed back to the queue, or run mode "queued" is a one-way trip.
  const released = await releaseBlockedJourneyRuns();
  const scheduled = await runScheduledJourneyEnrollments(stop);
  const events = await processJourneyEvents(50, stop);
  const runs = await processJourneyRuns(40, stop);
  // Pruning LAST and only with budget left: it is housekeeping, and a tick that
  // spent its time deleting instead of sending would be the wrong trade every
  // time. Whatever it does not reach, the next tick does.
  const pruned = stop.shouldStop() ? { events: 0, runs: 0 } : await pruneJourneyTraces();
  return {
    recoveredEvents: recoveredEvents.count,
    recoveredRuns: recoveredRuns.count,
    releasedBlocked: released,
    scheduled,
    eventsProcessed: events.processed,
    enrolled: events.enrolled,
    runsProcessed: runs,
    prunedEvents: pruned.events,
    prunedRuns: pruned.runs,
    // Visible in the cron response, so a run cut short by the budget is
    // diagnosable rather than looking like a quiet tick with nothing to do.
    stoppedEarly: stop.shouldStop(),
  };
}
