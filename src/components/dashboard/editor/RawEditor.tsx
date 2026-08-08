"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { parseConfigStrict } from "@/lib/dashboard/config";
import { useEditor } from "./EditorProvider";

/**
 * The escape hatch: the whole dashboard config, as JSON, in a box.
 *
 * ── WHY THIS EXISTS ALONGSIDE A GRAPHICAL EDITOR AT ALL ─────────────────────
 *
 * CardBuilder and ConditionEditor can only ever offer what somebody thought to
 * build a control for, and a config is a big enough document — twelve views,
 * each with its own sections and nested containers — that there will always be
 * a shape someone wants that the graphical surface has not caught up to yet.
 * This is that pressure valve: whatever `parseConfigStrict` accepts, this
 * dialog accepts, with no control missing because a component for it was never
 * written.
 *
 * ── NO textarea PRIMITIVE EXISTS IN components/ui, AND THAT IS FINE ─────────
 *
 * A full code editor is a dependency this app does not have and a JSON blob
 * pasted by hand does not need syntax highlighting to be editable — a plain
 * `<textarea>`, styled to match Input's own chrome, is what "build it plainly
 * with the existing primitives" means here.
 *
 * ── VALIDATION IS THE SAME PARSER, TWICE, FOR TWO DIFFERENT REASONS ─────────
 *
 * `JSON.parse` catches "this is not JSON at all" — a stray comma, an unclosed
 * brace, the kind of mistake anyone hand-editing a document makes. Once that
 * succeeds, `parseConfigStrict` — the SAME strict parser EditorProvider's
 * `update` already runs on every graphical edit — catches "this is JSON but
 * not a dashboard": an unknown card type, a filter naming a field the source
 * does not have, a view whose column count is out of range. Both error
 * messages are shown EXACTLY as the underlying function produced them. A
 * paraphrase risks saying something that is not quite what actually went
 * wrong, and the one person reading this message is looking straight at the
 * text that caused it.
 */
export default function RawEditor({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { config, update } = useEditor();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaId = useId();

  /*
   * Reformat from the LIVE config, but only at the moment the dialog OPENS —
   * not on every render while it stays open. Depending on `open` alone would
   * miss that; depending on `config` as well without this guard would blow
   * away whatever the person is mid-way through typing the instant something
   * else on the page (or this dialog's own successful Save, below) changes the
   * config underneath them. `wasOpen` is the difference between "reformat on
   * the transition into being open" and "reformat on every keystroke".
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setText(JSON.stringify(config, null, 2));
      setError(null);
    }
    wasOpen.current = open;
  }, [open, config]);

  function handleSave() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // Verbatim — see the file header. JSON.parse's own message ("Unexpected
      // token } in JSON at position 42") is more useful to someone staring at
      // the text than any rewording of it would be.
      setError(err instanceof Error ? err.message : "Invalid JSON.");
      return;
    }

    const result = parseConfigStrict(parsed);
    if (!result.ok) {
      // Also verbatim, and the dialog stays open with the text untouched — a
      // rejected save must leave the person exactly where they were, with the
      // one thing that is wrong named, not silently discarded.
      setError(result.error);
      return;
    }

    setError(null);
    update(() => result.config);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit as JSON</DialogTitle>
          <DialogDescription>
            The whole dashboard, exactly as it will be saved. For when the graphical editor has
            not caught up with what you want yet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor={textareaId} className="sr-only">
            Dashboard configuration, as JSON
          </Label>
          <textarea
            id={textareaId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-[50vh] w-full resize-none rounded-md border border-input bg-transparent p-3 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
