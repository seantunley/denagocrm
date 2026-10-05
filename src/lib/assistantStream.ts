/**
 * Showing DAX's answer while it is still being written (Hermes, Codex and
 * ChatGPT all stream). The model's reply ends with trailer lines the person
 * must never see — LEARN: (what to remember), ACTIONS: (task cards), CHOICES:
 * (buttons) — which askCrm strips from the finished answer. While streaming
 * they arrive a few characters at a time, so this decides, for the text so
 * far, what is safe to show: everything up to the first trailer line, minus a
 * last line that could still turn INTO one ("LEA…"). Pure, so it is tested.
 *
 * The streamed text is a preview: the finished, parsed answer replaces it.
 */

const TRAILERS = ["LEARN:", "ACTIONS:", "CHOICES:"];

/** Could this (unfinished) line still become a trailer? */
function mayBecomeTrailer(line: string): boolean {
  const start = line.trimStart();
  if (!start) return false;
  return TRAILERS.some((t) => t.startsWith(start) || start.startsWith(t));
}

export function visibleAnswer(soFar: string): string {
  const lines = soFar.split("\n");
  const shown: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = i === lines.length - 1;
    if (TRAILERS.some((t) => line.trimStart().startsWith(t))) break;
    if (last && mayBecomeTrailer(line)) break;
    shown.push(line);
  }
  return shown.join("\n").trimEnd();
}

/** The events the streaming route sends, one JSON object per line. */
export type AskStreamEvent =
  | { t: "status"; v: string }
  | { t: "text"; v: string }
  | { t: "done"; r: unknown };
