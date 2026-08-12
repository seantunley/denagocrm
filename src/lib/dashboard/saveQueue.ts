/**
 * Ordering rules for the dashboard editor's autosave.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ───────────────────────────────────────
 *
 * The editor saves on a trailing debounce, and the debounce was the ONLY thing
 * standing between the user and overlapping writes. It is not a lock. A save
 * could leave, the user could move another card, and a second save could leave
 * while the first was still in flight — two writes of the same whole document,
 * racing, with nothing deciding which of them was allowed to win.
 *
 * Three orderings that produced a wrong screen or a wrong row, all reachable by
 * dragging a card twice in a second on a slow connection:
 *
 *   1. OLD SUCCESS AFTER NEW SUCCESS. Save A (arrangement 1) and save B
 *      (arrangement 2) are both out. B lands first, then A. The client recorded
 *      A's arrangement as the committed one, so the screen and its idea of what
 *      is saved fell back a step; and if the two reached the database in that
 *      same order, the row ended up holding arrangement 1 — the OLDER edit as
 *      the last word.
 *
 *   2. NEW FAILURE AFTER OLD SUCCESS. A and B are both out. A succeeds. B is
 *      refused. B's failure handler restored the arrangement captured when B was
 *      DISPATCHED — which was arrangement 0, because A had not landed yet. The
 *      row held arrangement 1 and the screen showed arrangement 0. Nothing on
 *      screen said so; the user saw their card jump back two steps and had no
 *      way to know the database disagreed.
 *
 *   3. OLD FAILURE AFTER NEW SUCCESS. A fails, B succeeds, A's refusal arrives
 *      last. A's handler rolled the screen back over the top of B's accepted
 *      arrangement and raised an error about a save that had since been
 *      superseded. Row: arrangement 2. Screen: arrangement 0.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────
 *
 * ONE WRITER. `flush` never starts a write while one is in flight. The newest
 * arrangement waits in `queued` and goes out when the current write lands, so a
 * burst of edits collapses into the arrangement the user stopped on rather than
 * a convoy of writes racing each other. This is what fixes (2): the arrangement
 * a write rolls back TO is captured when that write is dispatched, and
 * dispatching only after the previous write settled means it is captured after
 * that write's outcome is known.
 *
 * GENERATION FENCING. Every dispatch takes the next number off a monotonic
 * counter. When a write settles it may only touch state if its number is still
 * the newest one issued — otherwise a newer write has already been dispatched
 * and this answer is about an arrangement nobody is looking at any more. It is
 * discarded in full: not applied on success, not rolled back on failure, not
 * announced. That single rule is what fixes (1) and (3), and it holds whether or
 * not the caller respected the one-writer rule.
 *
 * Both are kept, deliberately. The one-writer rule is the behaviour we want; the
 * fence is the invariant that stays true if a future caller writes outside the
 * queue — see `dispatch`, which is public precisely because the safety of an
 * overlapping write has to be a property of this module rather than of the
 * discipline of whoever calls it.
 *
 * ── WHY IT IS NOT IN THE PROVIDER ───────────────────────────────────────────
 *
 * It used to be, and that is why the orderings above shipped. A rule about which
 * of two in-flight responses may touch state cannot be checked by reading the
 * component, and the editor is a client component driving a DOM-measuring drag
 * library, so there is no renderer in this suite to exercise it in place. Here it
 * is plain TypeScript over injected callbacks, and tests/dashboardSaveQueue
 * resolves the two writes in whichever order it likes and asserts where the
 * screen and the row end up. Same reason lib/dashboard/canvasMove exists.
 */

/** What one write reported back. */
export type SaveOutcome =
  | {
      ok: true;
      /**
       * The revision the write produced, for the next write to fence against.
       * Null only where the caller has no revision scheme.
       */
      stamp: string | null;
    }
  | {
      ok: false;
      /**
       * True when the server refused because the row moved on under us — someone
       * else's write, another tab, another session. Distinguished from an
       * ordinary refusal because there is nothing to roll back TO: the row holds
       * neither our arrangement nor the one we would restore.
       */
      conflict?: boolean;
      message: string;
    };

export type SaveQueueOptions<C> = {
  /** The arrangement the server is known to hold when the session starts. */
  initialConfig: C;
  /** The revision that arrangement carries, or null if it has never been stored. */
  initialStamp: string | null;
  /** Perform one write, fenced against `stamp`. */
  write: (config: C, stamp: string | null) => Promise<SaveOutcome>;
  /**
   * The write was accepted and is now the newest arrangement the server holds.
   *
   * `previous` is what the server held before it — handed over rather than read
   * back, because by the time this runs the queue has already moved on and there
   * would be no way to ask.
   */
  onAccepted?: (config: C, stamp: string | null, previous: C) => void;
  /**
   * The write was refused and the screen must go back to `restore` — the last
   * arrangement the server is known to have accepted.
   */
  onRejected?: (restore: C, message: string) => void;
  /** The row moved on under us. Nothing is rolled back; see `conflict` above. */
  onConflict?: (message: string) => void;
  /** Whether a write is in flight, for the "Saving…" hint. */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Return true to hold a queued arrangement back rather than write it the
   * instant the current write lands.
   *
   * The editor debounces, and the debounce is what makes a drag one write
   * instead of thirty. Without this the queue would drain straight into the
   * half-finished arrangement the user is still moving, which is the wasteful
   * behaviour the debounce exists to prevent.
   */
  hold?: () => boolean;
};

export type SaveQueue<C> = {
  /** Queue an arrangement. Replaces anything queued and not yet written. */
  submit: (config: C) => void;
  /** The arrangement waiting to be written, if any. */
  queued: () => C | null;
  /**
   * Take the queued arrangement out of the queue without writing it. For the
   * unmount path, which has to write one last time with no component left to
   * report to.
   */
  takeQueued: () => C | null;
  /** Write the queued arrangement, unless a write is already in flight. */
  flush: () => Promise<void>;
  /**
   * Write this arrangement NOW, without waiting for one already in flight.
   *
   * Public because the generation fence has to be this module's guarantee rather
   * than an assumption about how carefully it is called: an overlapping write
   * must be safe, not merely avoided. `flush` is what the editor uses.
   */
  dispatch: (config: C) => Promise<void>;
  /** Resolves when nothing is in flight. */
  settled: () => Promise<void>;
  /** The newest arrangement the server has accepted. */
  committed: () => C;
  /** The revision the next write will fence against. */
  stamp: () => string | null;
  /**
   * Adopt an arrangement that came from the server, with the revision it carries.
   *
   * Both together, never a bare stamp: fencing against a revision whose content
   * we have not seen would let the next write overwrite it without a conflict,
   * which is the lost update this whole module is about.
   */
  reset: (config: C, stamp: string | null) => void;
  /** How many writes have been dispatched. Diagnostics and tests. */
  generation: () => number;
};

export function createSaveQueue<C>(options: SaveQueueOptions<C>): SaveQueue<C> {
  /** The newest arrangement the server has accepted. */
  let committed = options.initialConfig;
  /** The revision the next write fences against. */
  let stamp = options.initialStamp;
  /** Monotonic. See "generation fencing" above. */
  let issued = 0;
  /** The arrangement waiting to be written, if any. */
  let queued: C | null = null;
  /** The running drain, or null. This IS the one-writer rule. */
  let running: Promise<void> | null = null;

  async function dispatch(config: C): Promise<void> {
    const generation = (issued += 1);
    /*
     * Captured HERE, at dispatch, not when the edit was made.
     *
     * This is the arrangement a refusal puts back on screen, so it has to be one
     * the server actually holds. Under the one-writer rule the previous write
     * has already settled by now, so `committed` reflects its outcome — which is
     * exactly what ordering (2) got wrong when two writes could overlap.
     */
    const restore = committed;

    let outcome: SaveOutcome;
    try {
      outcome = await options.write(config, stamp);
    } catch (error) {
      // A thrown write is a refusal like any other. Letting it escape would
      // leave `running` dangling and the queue would never write again.
      outcome = {
        ok: false,
        message: error instanceof Error ? error.message : "Could not save your dashboard.",
      };
    }

    /*
     * THE FENCE. A newer write has been dispatched, so this answer is about an
     * arrangement that is no longer on screen and no longer the one the server
     * is being asked to hold. It may not be applied, may not be rolled back, and
     * may not be announced — an error about a superseded save is noise the user
     * cannot act on.
     */
    if (generation !== issued) return;

    if (outcome.ok) {
      committed = config;
      stamp = outcome.stamp;
      options.onAccepted?.(config, stamp, restore);
      return;
    }

    if (outcome.conflict) {
      options.onConflict?.(outcome.message);
      return;
    }

    options.onRejected?.(restore, outcome.message);
  }

  async function drain(): Promise<void> {
    // A `while`, so an edit made while a write was in flight goes out as soon as
    // that write lands rather than waiting for another debounce to elapse.
    for (;;) {
      const next = queued;
      if (next === null) return;
      queued = null;
      await dispatch(next);
      // Re-read: the user may have edited again while that write was out. `hold`
      // is what stops the loop chasing a drag that is still in progress.
      if (queued === null || options.hold?.() === true) return;
    }
  }

  function flush(): Promise<void> {
    // Already writing. The drain loop will pick up whatever is queued.
    if (running) return running;
    if (queued === null) return Promise.resolve();
    options.onBusyChange?.(true);
    const run = drain();
    /*
     * Assigned BEFORE the completion callback is attached, and cleared from a
     * `.finally` rather than inside `drain`, because a `finally` callback is
     * guaranteed to run in a later microtask than this synchronous assignment.
     * Clearing it from inside an async function that happened to complete without
     * awaiting would run before the assignment and strand `running` at a resolved
     * promise — every later flush would return that, and nothing would ever be
     * written again.
     */
    running = run;
    void run.finally(() => {
      if (running === run) running = null;
      options.onBusyChange?.(false);
    });
    return run;
  }

  return {
    submit(config) {
      queued = config;
    },
    queued: () => queued,
    takeQueued() {
      const taken = queued;
      queued = null;
      return taken;
    },
    flush,
    dispatch,
    settled: () => running ?? Promise.resolve(),
    committed: () => committed,
    stamp: () => stamp,
    reset(config, next) {
      committed = config;
      stamp = next;
    },
    generation: () => issued,
  };
}
