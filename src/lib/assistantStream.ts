/**
 * Showing DAX's answer while it is still being written (Hermes, Codex and
 * ChatGPT all stream). The model's reply ends with a block the person must
 * never see — the <<DAX>> marker and its JSON (assistantReply), or in the old
 * shape the LEARN: / ACTIONS: / CHOICES: lines — which askCrm strips from the
 * finished answer. While streaming they arrive a few characters at a time, so
 * this decides, for the text so far, what is safe to show: everything up to
 * the first block line, minus a last line that could still turn INTO one
 * ("<<DA…", "LEA…"). Evidence links ([[/leads/…]]) become chips only in the
 * finished answer, so here they are left out, and so is one still arriving.
 * Pure, so it is tested.
 *
 * The streamed text is a preview: the finished, parsed answer replaces it.
 */

const TRAILERS = ["<<DAX>>", "LEARN:", "ACTIONS:", "CHOICES:"];

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
  return shown
    .join("\n")
    .replace(/\[\[[^\]\n]*\]\]/g, "")
    // A link still arriving: "[[/quo", "[[/quotes/x]" (one bracket closed), or a lone "[" that may be its start.
    .replace(/\[\[?[^\]\n]*\]?$/, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trimEnd();
}

/** The events the streaming route sends, one JSON object per line. */
export type AskStreamEvent =
  | { t: "status"; v: string }
  | { t: "text"; v: string }
  | { t: "done"; r: unknown };
