/**
 * ASKING FOR THE MICROPHONE, CANCELLABLY (review of #1117 — the same class the #1113 review found in hands-free).
 *
 * getUserMedia waits on the browser's permission prompt, for as long as the person takes. Pressing Cancel or Stop, or
 * leaving the page, while it waits used to do nothing to it: grant permission afterwards and recording began anyway
 * — of a customer's phone call, with the Cancel already pressed. Each request now holds a ticket; cancel() voids it.
 * A microphone that arrives for a voided ticket is switched straight off, and start() reports null (nothing to do).
 *
 * One request at a time: a second start() while one is waiting is ignored (null), never a second prompt.
 *
 * No browser APIs here — `getMic` is passed in — so a test can hold the "permission prompt" open and cancel under it.
 */
export type MicStream = { getTracks(): { stop(): void }[] };

export function micRequest<S extends MicStream>(getMic: () => Promise<S>) {
  let ticket = 0;
  let waiting = false;
  return {
    /** True while the permission prompt (or the device) has not answered. */
    waiting: () => waiting,
    /** The microphone, or null when cancelled meanwhile or another request is already waiting. Throws a refusal. */
    async start(): Promise<S | null> {
      if (waiting) return null;
      const mine = ++ticket;
      waiting = true;
      try {
        const stream = await getMic();
        if (mine !== ticket) {
          stream.getTracks().forEach((track) => track.stop());
          return null;
        }
        return stream;
      } catch (error) {
        if (mine !== ticket) return null; // cancelled meanwhile: a refusal now is nobody's error
        throw error;
      } finally {
        if (mine === ticket) waiting = false;
      }
    },
    /** Cancel, Stop, unmount: whatever request is waiting comes to nothing. */
    cancel() {
      ticket++;
      waiting = false;
    },
  };
}
