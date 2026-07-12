import {
  processJourneyEvents,
  recoverStaleJourneyEvents,
} from "./journeyEvents";
import {
  processJourneyRuns,
  recoverStaleJourneyRuns,
} from "./journeyRuns";
import {
  enrollJourneyNow,
  runScheduledJourneyEnrollments,
} from "./journeyScheduling";

export { emitJourneyEvent, processJourneyEvents } from "./journeyEvents";
export { processJourneyRuns } from "./journeyRuns";
export { enrollJourneyNow, runScheduledJourneyEnrollments } from "./journeyScheduling";

export async function runJourneyEngine() {
  const [recoveredEvents, recoveredRuns] = await Promise.all([
    recoverStaleJourneyEvents(),
    recoverStaleJourneyRuns(),
  ]);
  const scheduled = await runScheduledJourneyEnrollments();
  const events = await processJourneyEvents();
  const runs = await processJourneyRuns();
  return {
    recoveredEvents: recoveredEvents.count,
    recoveredRuns: recoveredRuns.count,
    scheduled,
    eventsProcessed: events.processed,
    enrolled: events.enrolled,
    runsProcessed: runs,
  };
}
