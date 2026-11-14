/**
 * GETTING THE MICROPHONE, cancellably — the ONE way the app asks for it (hands-free, review of #1113; Log a call and
 * the DAX chat mic through useVoiceRecorder, review of #1117). Asking waits on the browser's permission prompt for as
 * long as the person takes, and Stop, Cancel, closing the chat or leaving the page can all happen during that wait. A
 * stream that arrives after any of them must be let go at once and must start nothing — never a recording of a
 * customer's call after Cancel was pressed — and a second start replaces the first, whose stream is let go the same way.
 *
 * Each start takes a ticket; cancel() and any newer start make it stale. After EVERY wait the ticket is checked, and a
 * stale one stops the stream's tracks, releases the wake lock and resolves null. `wakeLock` (keep the screen on) is
 * optional: hands-free asks for one, the recorder does not. `waiting()` says a start is still at the prompt, so a
 * caller can refuse to open a second one. Injected, so a test can hold the prompt open.
 */
type Stream = { getTracks(): { stop(): void }[] };
type WakeLock = { release(): Promise<void> };
export type MicDeps<S extends Stream, W extends WakeLock> = { getMic: () => Promise<S>; wakeLock?: () => Promise<W | null> };

export function micStarter<S extends Stream, W extends WakeLock = WakeLock>(deps: MicDeps<S, W>) {
  let ticket = 0;
  // The ticket of the start still waiting, or 0.
  let waitingFor = 0;
  const letGo = (stream: S, wake: W | null) => {
    stream.getTracks().forEach((track) => track.stop());
    void wake?.release().catch(() => undefined);
  };
  return {
    /** The microphone (and the screen kept on, if asked and the browser allows), or null when stopped or replaced meanwhile. */
    async start(): Promise<{ stream: S; wake: W | null } | null> {
      const mine = ++ticket;
      waitingFor = mine;
      try {
        let stream: S;
        try {
          stream = await deps.getMic();
        } catch (error) {
          if (mine !== ticket) return null; // stopped meanwhile: a refusal now is nobody's error
          throw error;
        }
        if (mine !== ticket) {
          letGo(stream, null);
          return null;
        }
        const wake = deps.wakeLock ? await deps.wakeLock().catch(() => null) : null;
        if (mine !== ticket) {
          letGo(stream, wake);
          return null;
        }
        return { stream, wake };
      } finally {
        if (waitingFor === mine) waitingFor = 0;
      }
    },
    /** True while a start has not been answered (the permission prompt is open). */
    waiting: () => waitingFor !== 0,
    /** Stop, Cancel, toggle off, close, unmount, tab hidden: whatever start is waiting comes to nothing. */
    cancel() {
      ticket++;
      waitingFor = 0;
    },
  };
}
