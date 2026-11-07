"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Keyboard } from "lucide-react";
import { Dialog, DialogDescription, DialogHeader, DialogTitle, ResponsiveDialogContent } from "@/components/ui/dialog";
import { isEditableTarget } from "@/lib/appContextMenu";
import { listKeyAction, rowDestination, SHORTCUTS, stepIndex } from "@/lib/listKeys";

/** Rows on screen, in reading order — a list rendered twice (phone and desktop) counts once, as shown. */
function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-nav-row]")].filter((row) => row.getClientRects().length > 0);
}

/** A dialog, menu or a card mid-drag owns the keyboard while it is open. */
function overlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [aria-roledescription][aria-pressed="true"]'));
}

/**
 * j / k / Enter / e / w / a / 1–5 / ? on lists and the board — the DOM half. What each
 * key means is decided in `@/lib/listKeys` (tested there). Mounted once in the signed-in
 * layout and listening on `document`, like the right-click menu: a page opts in by
 * marking its rows, not by wrapping anything.
 */
export default function ListKeyboard() {
  const router = useRouter();
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const onRow = Boolean(focused?.hasAttribute("data-nav-row"));
      const action = listKeyAction({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        typing: target ? isEditableTarget(target) || target.tagName === "INPUT" : false,
        overlayOpen: overlayOpen(),
        onRow,
      });
      if (!action) return;

      if (action.kind === "help") {
        event.preventDefault();
        setHelp(true);
        return;
      }
      if (action.kind === "move") {
        const rows = visibleRows();
        if (rows.length === 0) return;
        event.preventDefault();
        const next = rows[stepIndex(onRow && focused ? rows.indexOf(focused) : -1, rows.length, action.by)];
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
      if (action.kind === "stage") {
        const stage = [...document.querySelectorAll<HTMLElement>("[data-nav-stage]")][action.index];
        if (!stage) return;
        event.preventDefault();
        stage.scrollIntoView({ block: "nearest", inline: "start" });
        const first = [...stage.querySelectorAll<HTMLElement>("[data-nav-row]")][0];
        (first ?? stage).focus({ preventScroll: true });
        return;
      }
      if (!focused) return;
      const url = rowDestination(action, { href: focused.dataset.navHref, lead: focused.dataset.navLead });
      if (!url) return;
      event.preventDefault();
      router.push(url);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <Dialog open={help} onOpenChange={setHelp}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Keyboard className="size-4" />Keyboard shortcuts</DialogTitle>
          <DialogDescription>On the board and in lists. Not while you are typing in a field.</DialogDescription>
        </DialogHeader>
        <dl className="divide-y divide-border text-sm">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.does} className="flex items-center justify-between gap-4 py-2">
              <dt className="flex shrink-0 gap-1">
                {shortcut.keys.map((key) => key === "–"
                  ? <span key={key} className="text-muted-foreground">–</span>
                  : <kbd key={key} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{key}</kbd>)}
              </dt>
              <dd className="text-right text-muted-foreground">{shortcut.does}</dd>
            </div>
          ))}
        </dl>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
