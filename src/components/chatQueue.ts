/**
 * TYPE WHILE DAX WORKS — the chat's one-answer-at-a-time rule, as a pure reducer (tested in tests/chatQueue.test.ts).
 *
 * `running` is the question being answered now; anything asked meanwhile waits in `queue`, in order, and can be
 * taken back (edited) or removed before it goes. When the running one finishes — answered or stopped — the next
 * queued one becomes `running` in the same step, so the chat never has two answers in flight and never sits idle
 * with a queue. `stopping` is the moment between pressing Stop and the server saying whether it stopped.
 */
export type ChatItem<I = unknown> = { id: number; text: string; image: I | null };
export type ChatQueue<I = unknown> = { running: ChatItem<I> | null; queue: ChatItem<I>[]; stopping: boolean; nextId: number };
export type ChatQueueAction<I = unknown> =
  | { type: "ask"; text: string; image?: I | null }
  /** The running question is over: answered, failed, or stopped. */
  | { type: "finished"; id: number }
  | { type: "stopping" }
  /** Too late to stop — it had finished; its answer arrives as usual. */
  | { type: "stopRefused" }
  /** Taken out of the queue (removed, or back into the composer to edit). */
  | { type: "remove"; id: number };

export const emptyChatQueue = <I>(): ChatQueue<I> => ({ running: null, queue: [], stopping: false, nextId: 1 });

export function chatQueue<I>(state: ChatQueue<I>, action: ChatQueueAction<I>): ChatQueue<I> {
  switch (action.type) {
    case "ask": {
      const text = action.text.trim();
      if (!text && !action.image) return state;
      const item = { id: state.nextId, text, image: action.image ?? null };
      return state.running
        ? { ...state, queue: [...state.queue, item], nextId: state.nextId + 1 }
        : { ...state, running: item, nextId: state.nextId + 1 };
    }
    case "finished": {
      if (state.running?.id !== action.id) return state;
      const [next = null, ...rest] = state.queue;
      return { ...state, running: next, queue: rest, stopping: false };
    }
    case "stopping":
      return state.running ? { ...state, stopping: true } : state;
    case "stopRefused":
      return { ...state, stopping: false };
    case "remove":
      return { ...state, queue: state.queue.filter((item) => item.id !== action.id) };
  }
}
