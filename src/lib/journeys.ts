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
import {
  processAutomationOutbox,
  recoverStaleAutomationOutbox,
} from "./automationOutbox";

export { emitJourneyEvent, processJourneyEvents } from "./journeyEvents";
export { processJourneyRuns } from "./journeyRuns";
export { enrollJourneyNow, runScheduledJourneyEnrollments } from "./journeyScheduling";
export { processAutomationOutbox } from "./automationOutbox";

export async function runJourneyEngine() {
  const [recoveredEvents, recoveredRuns, recoveredOutbox] = await Promise.all([
    recoverStaleJourneyEvents(),
    recoverStaleJourneyRuns(),
    recoverStaleAutomationOutbox(),
  ]);
  const scheduled = await runScheduledJourneyEnrollments();
  const events = await processJourneyEvents();
  const runs = await processJourneyRuns();
  const outbox = await processAutomationOutbox();
  return {
    recoveredEvents: recoveredEvents.count,
    recoveredRuns: recoveredRuns.count,
    recoveredOutbox: recoveredOutbox.count,
    scheduled,
    eventsProcessed: events.processed,
    enrolled: events.enrolled,
    runsProcessed: runs,
    outboxProcessed: outbox.processed,
    outboxCompleted: outbox.completed,
  };
}
