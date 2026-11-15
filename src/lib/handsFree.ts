/**
 * HANDS-FREE DAX (Sean, 2026-11-14: "Still press-to-talk, then press Listen. A continuous spoken mode suits driving
 * and the workshop"). One tap starts a loop — listen, hear, think, speak, listen again — until it is stopped.
 *
 * Pure, so the rules a test must hold are here and not in the browser code (components/useHandsFree):
 *  - the microphone records ONLY while listening — never while DAX is speaking, so it can't hear itself;
 *  - an event that doesn't belong to the phase it arrives in is ignored (a late transcript after Stop asks nothing);
 *  - it stops on its own after a run of failed hearings, and the listening side stops after a long silence.
 * Nothing here writes or confirms anything: cards that change the CRM still need their tap.
 */

/** Calibration knobs — a workshop is not a quiet office, so these are tuned, not fixed truths. */
export const HANDS_FREE = {
  /** A pause this long after speech ends the question. */
  silenceMs: 1200,
  /** Less speech than this is a cough, a door or a drill — not a question. */
  minSpeechMs: 400,
  /** Nothing said for this long: stop listening. */
  idleMs: 120_000,
  /** Quietest level that can count as speech (RMS, 0–1). */
  minLevel: 0.015,
  /** Speech is this many times louder than the room's background. */
  ratio: 3,
  /** How fast the background estimate creeps UP towards a louder room, per frame (it drops at once). */
  floorRise: 0.02,
  /** The start of each listening round measures the room: a workshop's steady noise is background, not a question. */
  calibrateMs: 300,
  /** This many hearings in a row that came back empty or failed: stop. */
  maxFailures: 3,
} as const;

export type Phase = "off" | "starting" | "listening" | "hearing" | "thinking" | "speaking";
export type HandsFree = { phase: Phase; failures: number; stopped: string | null };
export type HandsFreeEvent =
  /** The tap: waiting for the microphone (the permission prompt). Stop works from here. */
  | { type: "starting" }
  /** The microphone is ours: listening. Only from "starting" — a late grant after Stop starts nothing. */
  | { type: "start" }
  /** The person spoke and paused: the recording goes to be transcribed. */
  | { type: "spoke" }
  /** Transcribed: the question is asked. */
  | { type: "heard" }
  /** Transcribed to nothing, or failed. */
  | { type: "notHeard" }
  /** The answer is in: spoken when it can be, otherwise straight back to listening. */
  | { type: "answered"; speak: boolean }
  /** Finished speaking (or couldn't). */
  | { type: "spokenEnd" }
  | { type: "stop"; reason?: string };

export const HANDS_FREE_OFF: HandsFree = { phase: "off", failures: 0, stopped: null };

const listening = (s: HandsFree, failures = s.failures): HandsFree => ({ phase: "listening", failures, stopped: null });

export function handsFreeStep(s: HandsFree, e: HandsFreeEvent): HandsFree {
  if (e.type === "stop") return s.phase === "off" ? s : { ...HANDS_FREE_OFF, stopped: e.reason ?? null };
  if (e.type === "starting") return s.phase === "off" ? { phase: "starting", failures: 0, stopped: null } : s;
  if (e.type === "start") return s.phase === "starting" ? listening(s, 0) : s;
  switch (s.phase) {
    case "listening":
      return e.type === "spoke" ? { ...s, phase: "hearing" } : s;
    case "hearing":
      if (e.type === "heard") return { ...s, phase: "thinking", failures: 0 };
      if (e.type === "notHeard") {
        const failures = s.failures + 1;
        return failures >= HANDS_FREE.maxFailures
          ? { ...HANDS_FREE_OFF, stopped: "Hands-free stopped — I couldn't make out the last few tries. Tap the mic to start again." }
          : listening(s, failures);
      }
      return s;
    case "thinking":
      return e.type === "answered" ? (e.speak ? { ...s, phase: "speaking" } : listening(s)) : s;
    case "speaking":
      return e.type === "spokenEnd" ? listening(s) : s;
    default:
      return s;
  }
}

/** The one rule the microphone obeys. */
export const mayRecord = (s: HandsFree) => s.phase === "listening";

export const HANDS_FREE_LABEL: Record<Exclude<Phase, "off">, string> = {
  starting: "Starting — allow the microphone if asked",
  listening: "Listening — just talk",
  hearing: "Got it…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export const IDLE_STOPPED = "Hands-free stopped — nothing heard for 2 minutes. Tap the mic to start again.";
export const HIDDEN_STOPPED = "Hands-free stopped — the page went to the background.";

// Getting the microphone, cancellably, is lib/micStarter — shared with the recorder (useVoiceRecorder).

/** Silence detection, one frame of microphone level at a time. */
export type Vad = { floor: number; speechMs: number; silenceMs: number; quietMs: number; warmMs: number };
export const freshVad = (): Vad => ({ floor: HANDS_FREE.minLevel / HANDS_FREE.ratio, speechMs: 0, silenceMs: 0, quietMs: 0, warmMs: 0 });

/**
 * "send": they spoke (long enough to be a question) and then paused. "idle": nothing said for idleMs.
 * The first calibrateMs only measure the room. After that the background follows it: it drops at once to anything
 * quieter and creeps up towards anything louder — so someone already talking when it starts is still heard, because
 * the gaps between their words pull the background back down.
 */
export function vadStep(v: Vad, level: number, dtMs: number): { vad: Vad; verdict: "wait" | "send" | "idle" } {
  if (v.warmMs < HANDS_FREE.calibrateMs) {
    const floor = v.warmMs === 0 ? level : (v.floor + level) / 2;
    return { vad: { ...v, floor, warmMs: v.warmMs + dtMs, quietMs: v.quietMs + dtMs }, verdict: "wait" };
  }
  const speaking = level > Math.max(HANDS_FREE.minLevel, v.floor * HANDS_FREE.ratio);
  const floor = level < v.floor ? level : v.floor + (level - v.floor) * HANDS_FREE.floorRise;
  let speechMs = v.speechMs + (speaking ? dtMs : 0);
  const silenceMs = speaking ? 0 : v.silenceMs + dtMs;
  // A short burst followed by a pause was noise: forget it.
  if (silenceMs >= HANDS_FREE.silenceMs && speechMs < HANDS_FREE.minSpeechMs) speechMs = 0;
  const heard = speechMs >= HANDS_FREE.minSpeechMs;
  const quietMs = heard || speaking ? 0 : v.quietMs + dtMs;
  const vad = { floor, speechMs, silenceMs, quietMs, warmMs: v.warmMs };
  if (heard && silenceMs >= HANDS_FREE.silenceMs) return { vad, verdict: "send" };
  if (quietMs >= HANDS_FREE.idleMs) return { vad, verdict: "idle" };
  return { vad, verdict: "wait" };
}

/** Root-mean-square level of one buffer of samples (-1…1). */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** The toggle, remembered on this device only. Storage can be missing or blocked: then it's simply off. */
const KEY = "dax.handsFree";
export function handsFreePreferred(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberHandsFree(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Not remembered — it still works for this visit.
  }
}
