"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Link2,
  Printer,
  RotateCw,
  SquareArrowOutUpRight,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import ModalPortal from "@/components/ui/modal-portal";
import {
  buildContextMenu,
  flattenSections,
  focusOnOpen,
  isEditableTarget,
  isKeyboardInvocation,
  placeMenu,
  shouldUseNativeMenu,
  type ContextMenuAction,
  type ContextMenuSection,
} from "@/lib/appContextMenu";

/**
 * The app's right-click menu — the DOM half. The decisions live in
 * `@/lib/appContextMenu`, which has no DOM in it and is where the tests are.
 *
 * Mounted once, in the signed-in layout, and works by listening on `document`
 * rather than by wrapping anything. That is deliberate: the alternative is a
 * provider every page has to opt into, and a menu that exists on 13 pages out of
 * 137 is the situation this replaces.
 *
 * ── HOW IT COEXISTS WITH THE MENU THAT ALREADY EXISTS ───────────────────────
 *
 * `RecordContextMenu` gives contacts, leads, quotes, stock and ten other lists a
 * real per-record menu (open, edit, quick-create, copy). That is a BETTER menu
 * than this one and it stays exactly as it is. Radix calls `preventDefault()` on
 * the rows it owns, this listener is on `document` in the bubble phase, and
 * `shouldUseNativeMenu` bails on an already-prevented event — so the record menu
 * wins wherever it exists, and this one fills in everywhere else. The flow
 * canvases claim their own right-click the same way and are unaffected.
 *
 * ── WHAT IT DOES NOT TAKE AWAY ──────────────────────────────────────────────
 *
 * Inputs keep the native menu, because Paste cannot be reimplemented. Shift+
 * right-click forces the native menu anywhere. Both are explained at length in
 * `shouldUseNativeMenu` — they are the reason this is an improvement rather than
 * a prettier way of removing features.
 */

const ICONS: Record<string, LucideIcon> = {
  open: SquareArrowOutUpRight,
  "open-new-tab": ExternalLink,
  "open-image": ImageIcon,
  "copy-link": Link2,
  "copy-image": ImageIcon,
  "copy-selection": Copy,
  "copy-page": Link2,
  back: ArrowLeft,
  forward: ArrowRight,
  reload: RotateCw,
  print: Printer,
};

type OpenState = {
  x: number;
  y: number;
  sections: ContextMenuSection[];
  /** The route it was opened on — see the derived `open` below. */
  pathname: string;
  /** Opened by the Menu key rather than a right-click; decides where focus goes. */
  keyboard: boolean;
};

export default function AppContextMenu() {
  const [state, setState] = useState<OpenState | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const close = useCallback(() => {
    setState(null);
    setPlaced(null);
  }, []);

  /*
   * A navigation must not leave a menu floating over the new page — "Open" is an
   * item in this very menu, so that is the common case, not an edge one.
   *
   * DERIVED, not an effect. Closing it in a `useEffect` on `pathname` sets state
   * during the commit of the new route, which renders the stale menu for one
   * frame and trips react-hooks/set-state-in-effect. Comparing the route the
   * menu was opened on with the current one answers the same question during
   * render, so the menu is simply never drawn on a page it was not opened on.
   */
  const open = state && state.pathname === pathname ? state : null;

  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const editableNode = target.closest?.(
        "input, textarea, select, [contenteditable]",
      ) as HTMLElement | null;
      const editable = editableNode
        ? isEditableTarget({
            tagName: editableNode.tagName,
            isContentEditable: editableNode.isContentEditable,
            readOnly: (editableNode as HTMLInputElement).readOnly,
            type: (editableNode as HTMLInputElement).type,
          })
        : false;

      if (
        shouldUseNativeMenu({
          editable,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
        })
      ) {
        return;
      }

      const anchor = target.closest?.("a[href]") as HTMLAnchorElement | null;
      const image = (target.closest?.("img[src]") as HTMLImageElement | null) ?? null;
      const selection = window.getSelection?.()?.toString() ?? "";

      const sections = buildContextMenu({
        linkHref: anchor?.href ?? null,
        linkIsExternal: anchor ? anchor.origin !== window.location.origin : false,
        imageSrc: image?.currentSrc || image?.src || null,
        selectionText: selection,
        pageHref: window.location.href,
        // history.length is 1 only on a tab whose first entry is this page.
        canGoBack: window.history.length > 1,
      });

      event.preventDefault();
      setPlaced(null);
      setState({
        x: event.clientX,
        y: event.clientY,
        sections,
        pathname: window.location.pathname,
        keyboard: isKeyboardInvocation(event),
      });
    }

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Measure, then place. Rendered invisibly for one frame so the flip decision is
  // made against the menu's real size rather than a guess.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setPlaced(
      placeMenu({
        x: open.x,
        y: open.y,
        menuWidth: rect.width,
        menuHeight: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
    /*
     * WHERE FOCUS LANDS, and why it depends on how the menu was opened.
     *
     * This focused the container in every case, which left a keyboard user on a
     * `role="menu"` with nothing selected: Enter and Space did nothing until an
     * arrow key was pressed first. A menu that declares the role, and implements
     * arrows and Home/End, has to honour the rest of that contract too.
     *
     * But focusing the first item unconditionally is wrong the other way. No
     * native context menu preselects an entry on a right-click, and neither does
     * Radix; a highlighted first row sitting under the cursor is both unfamiliar
     * and an accidental Enter away from "Open". So the keyboard gets the first
     * item, the mouse gets the container, and arrows work identically from both.
     */
    focusOnOpen(menuRef.current, open.keyboard);
  }, [open]);

  // Anything that moves the page out from under the menu closes it. Scroll is
  // captured because a scrollable panel's scroll does not bubble to document.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    const onResize = () => close();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  const run = useCallback(
    async (action: ContextMenuAction) => {
      close();
      switch (action.kind) {
        case "open":
          if (action.value) router.push(action.value);
          break;
        case "open-new-tab":
          if (action.value) window.open(action.value, "_blank", "noopener,noreferrer");
          break;
        case "copy":
          if (!action.value) break;
          try {
            await navigator.clipboard.writeText(action.value);
            toast.success(action.copiedMessage ?? "Copied");
          } catch {
            // Clipboard write is refused without a secure context or permission.
            // Say so rather than silently doing nothing.
            toast.error("Could not copy — your browser blocked clipboard access");
          }
          break;
        case "back":
          router.back();
          break;
        case "forward":
          router.forward();
          break;
        case "reload":
          window.location.reload();
          break;
        case "print":
          window.print();
          break;
      }
    },
    [close, router],
  );

  if (!open) return null;

  const items = flattenSections(open.sections);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const focusables = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ?? [],
    );
    if (focusables.length === 0) return;
    const index = focusables.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = index < 0 ? (delta === 1 ? 0 : focusables.length - 1) : (index + delta + focusables.length) % focusables.length;
      focusables[next]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      focusables[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      focusables[focusables.length - 1]?.focus();
    }
  }

  return (
    <ModalPortal>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Page actions"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
        style={{
          left: placed?.left ?? open.x,
          top: placed?.top ?? open.y,
          // Hidden for the single frame between render and measurement, so the
          // menu is never seen in the wrong place before it flips.
          visibility: placed ? "visible" : "hidden",
        }}
        className="fixed z-[80] min-w-56 origin-top-left overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-hidden animate-in fade-in-0 zoom-in-95 duration-100"
      >
        {open.sections.map((section, sectionIndex) => (
          <div key={sectionIndex}>
            {sectionIndex > 0 && <div className="-mx-1 my-1 h-px bg-border" role="separator" />}
            {section.map((action) => {
              const Icon = ICONS[action.id] ?? null;
              return (
                <button
                  key={action.id}
                  type="button"
                  data-menu-item
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => void run(action)}
                  className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
                >
                  {Icon ? <Icon aria-hidden /> : null}
                  <span className="truncate">{action.label}</span>
                  {action.hint ? (
                    <span className="ml-auto pl-3 text-xs tracking-wide text-muted-foreground/70">
                      {action.hint}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
        {items.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No actions here</div>
        ) : null}
      </div>
    </ModalPortal>
  );
}
