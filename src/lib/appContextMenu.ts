/**
 * WHAT THE RIGHT-CLICK MENU SHOULD SAY — the decision half, with no DOM in it.
 *
 * The browser's own context menu is grey, system-font, and looks like nothing
 * else in this app. Replacing it is easy; replacing it WITHOUT taking something
 * away from the person right-clicking is the hard part, and that is what most of
 * this file is about.
 *
 * A web page cannot reproduce the native menu. It has no "Inspect", no "Save
 * image as", no "Translate", and — the one that matters — no reliable Paste:
 * reading the clipboard needs a permission prompt in Chrome and is refused
 * outright in Firefox. So the rule here is NOT "replace it everywhere". It is
 * "replace it where we can do better, and stay out of the way where we cannot".
 *
 * See `shouldUseNativeMenu` for the three cases we deliberately decline.
 */

export type ContextTarget = {
  /** href of the nearest enclosing <a>, if any. */
  linkHref?: string | null;
  /** Whether that link leaves this app (different origin). */
  linkIsExternal?: boolean;
  /** src of the image under the cursor, if any. */
  imageSrc?: string | null;
  /** Text currently selected on the page, already trimmed. */
  selectionText?: string | null;
  /** The current page's own address, for "Copy page link". */
  pageHref?: string | null;
  /** False on the first entry of a session, when Back would leave the app. */
  canGoBack?: boolean;
};

export type ContextMenuActionKind =
  | "open"
  | "open-new-tab"
  | "copy"
  | "back"
  | "forward"
  | "reload"
  | "print";

export type ContextMenuAction = {
  /** Stable id, used as the React key and by the tests. */
  id: string;
  label: string;
  kind: ContextMenuActionKind;
  /** For open/open-new-tab: where to go. For copy: what to put on the clipboard. */
  value?: string;
  /** Shown right-aligned, e.g. "Alt+←". Cosmetic only — we do not bind these. */
  hint?: string;
  /** What the toast says after a successful copy. */
  copiedMessage?: string;
};

/** A group of actions; the renderer draws a separator between groups. */
export type ContextMenuSection = ContextMenuAction[];

/**
 * The three cases where the NATIVE menu is the better menu, and we let it
 * through untouched.
 *
 * 1. EDITABLE FIELDS. Paste, Undo, spellcheck suggestions, and the browser's
 *    saved addresses and cards all live in the native menu, and not one of them
 *    can be reimplemented from a web page. Hijacking right-click inside an input
 *    to show a prettier menu WITHOUT a working Paste is a straight downgrade,
 *    and it is the single most common right-click in any CRM: paste a phone
 *    number, paste an email, fix a spelling. So inputs, textareas and
 *    contenteditable regions keep the browser's menu.
 *
 * 2. SHIFT HELD. Firefox has always treated Shift+right-click as "give me the
 *    real menu regardless". Honouring it in every browser makes that an
 *    app-wide escape hatch: anything the native menu can do and ours cannot —
 *    Inspect, Save image as, View source — is one modifier away, everywhere.
 *
 * 3. ALREADY HANDLED. `RecordContextMenu` (Radix) calls preventDefault on the
 *    rows it owns, and so do the flow canvases. If something upstream has
 *    already claimed this click, we must not open a second menu on top of it.
 */
export function shouldUseNativeMenu(event: {
  editable: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return event.editable || event.shiftKey || event.defaultPrevented;
}

/**
 * True for the elements whose native menu carries Paste and spellcheck.
 *
 * `contentEditable` is inherited, so this deliberately asks about the computed
 * state of the node rather than the presence of the attribute — a caret inside a
 * rich-text editor is in an editable context even when the exact node under the
 * cursor is a plain <span>. The DOM half passes `isContentEditable`, which is
 * the inherited answer.
 */
export function isEditableTarget(target: {
  tagName?: string | null;
  isContentEditable?: boolean;
  readOnly?: boolean;
  type?: string | null;
}): boolean {
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toLowerCase();
  // A READONLY TEXTAREA IS STILL A TEXT FIELD. This read `!target.readOnly`,
  // which meant a readonly textarea lost the native menu — and so lost the
  // browser's own Copy, Select all and selection handling over its contents. Our
  // menu cannot replace those: it copies the page's *selection*, and offers
  // nothing for a caret sitting in a scrollable block of text.
  //
  // It also contradicted the readonly-input rule three lines down, which had
  // already reasoned the point out correctly. Readonly fields in this app —
  // generated references, API keys, rendered message bodies — exist precisely to
  // be copied out of, and that is the one thing this broke.
  if (tag === "textarea") return true;
  if (tag === "select") return true; // native option list — ours cannot replace it
  if (tag !== "input") return false;
  // A readonly input has no Paste, but it DOES have "Copy" and the browser's
  // selection handling, for the same reason as the textarea above. Left alone.
  const type = (target.type ?? "text").toLowerCase();
  // Checkboxes, radios and buttons carry no text and no Paste — our menu is
  // strictly better on those, so they are not "editable" for this purpose.
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
}

/**
 * Was this menu asked for by the KEYBOARD rather than the mouse?
 *
 * It decides where focus lands, and the two cases genuinely want different
 * answers. A `role="menu"` opened from the keyboard must start on a usable
 * `menuitem`, or Enter does nothing until an arrow key is pressed first — the
 * menu announces itself to a screen reader and then ignores the obvious key. A
 * menu opened by mouse must NOT preselect an item: no native context menu does,
 * nor does Radix, and a highlighted first entry under the cursor invites an
 * accidental Enter on "Open".
 *
 * `button` IS THE WHOLE SIGNAL, and it has to be — 2 is the secondary button, so
 * a real right-click reports 2 and the Menu key reports 0.
 *
 * An earlier version also accepted `detail === 0` as evidence of the keyboard.
 * That was wrong, and wrong in the direction that breaks the mouse. `detail` is
 * a CLICK COUNT, and only for click/dblclick/mousedown/mouseup; every other UI
 * event reports 0, `contextmenu` included. So an ordinary right-click arrives as
 * `button: 2, detail: 0` and was classified as keyboard — preselecting the first
 * item on every right-click, the exact thing the paragraph above says not to do.
 *
 * The tests that covered it were no better: they asserted `detail: 1` and
 * `detail: 2` for right-clicks, values a `contextmenu` event never carries. They
 * described a browser that does not exist and passed against it.
 *
 * Long-press on touch reports `button: 0` and is treated as keyboard here —
 * harmless, since the only consequence is that the first item starts focused.
 * An event with no `button` at all defaults to keyboard for the same reason:
 * a preselected item is a small oddity, a dead Enter key is a broken menu.
 *
 * NOTE: Shift+F10 — the other keyboard route — never reaches this menu at all,
 * because `shouldUseNativeMenu` bails on a held Shift. That is the escape hatch
 * working as intended: Shift+F10 gets the browser's own accessible menu, which
 * is a fine outcome. The plain Menu key is the route into ours.
 */
export function isKeyboardInvocation(event: { button?: number; detail?: number }): boolean {
  // `detail` is accepted because the caller hands over the whole MouseEvent, and
  // is deliberately NOT consulted — see above. Leaving it in the signature keeps
  // the trap documented at the place someone would reach for it again.
  return (event.button ?? 0) !== 2;
}

/** The bit of an element this module needs; keeps the DOM out of here. */
type Focusable = { focus: (options?: { preventScroll?: boolean }) => void };

/**
 * Put focus where the menu was opened FROM implies it should go, and return what
 * received it.
 *
 * Lives here, rather than inline in the component, so the behaviour the review
 * caught is covered by a test that runs the real code path instead of grepping
 * the component for a line that looks right. (A selector that reads correctly in
 * the source and matches nothing at runtime is a mistake this repo has already
 * shipped once — see tests/darkThemeControls.test.ts.)
 *
 * Falls back to the container if the menu somehow has no items, because a menu
 * with nothing focusable must still take the keyboard: Escape has to work.
 */
export function focusOnOpen<T extends Focusable>(
  container: T & { querySelector: (selector: string) => Focusable | null },
  keyboard: boolean,
): "item" | "container" {
  if (!keyboard) {
    container.focus({ preventScroll: true });
    return "container";
  }
  const first = container.querySelector("[data-menu-item]");
  if (!first) {
    container.focus({ preventScroll: true });
    return "container";
  }
  first.focus({ preventScroll: true });
  return "item";
}

/** A short, single-line version of a selection, for the menu label. */
export function truncate(text: string, max = 24): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The menu, as sections, for a given target.
 *
 * Ordered by how specific it is: what you clicked ON first, then the selection,
 * then the page. That matches every native menu, and it means the item you most
 * likely wanted is nearest the cursor.
 *
 * NOTE ON WHAT IS NOT HERE: there is no "Search the web for …". The native menu
 * offers it, and it is the one native item deliberately left out — a selection
 * in this app is usually a customer's name, phone number or address, and that
 * item would put it in a Google URL. This is a POPIA-governed system; a menu
 * item is not worth an unlogged export of personal information to a third party.
 */
export function buildContextMenu(target: ContextTarget): ContextMenuSection[] {
  const sections: ContextMenuSection[] = [];

  if (target.linkHref) {
    const link: ContextMenuSection = [
      { id: "open", label: "Open", kind: "open", value: target.linkHref },
      {
        id: "open-new-tab",
        label: "Open in new tab",
        kind: "open-new-tab",
        value: target.linkHref,
        hint: "Ctrl+click",
      },
      {
        id: "copy-link",
        label: target.linkIsExternal ? "Copy external link" : "Copy link",
        kind: "copy",
        value: target.linkHref,
        copiedMessage: "Link copied",
      },
    ];
    sections.push(link);
  }

  if (target.imageSrc) {
    sections.push([
      {
        id: "open-image",
        label: "Open image in new tab",
        kind: "open-new-tab",
        value: target.imageSrc,
      },
      {
        id: "copy-image",
        label: "Copy image address",
        kind: "copy",
        value: target.imageSrc,
        copiedMessage: "Image address copied",
      },
    ]);
  }

  const selection = target.selectionText?.trim();
  if (selection) {
    sections.push([
      {
        id: "copy-selection",
        label: `Copy “${truncate(selection)}”`,
        kind: "copy",
        value: selection,
        hint: "Ctrl+C",
        copiedMessage: "Copied",
      },
    ]);
  }

  // Navigation is always available, and is the reason this menu earns its place
  // on a page with nothing else on it: Back is the most-used item in the native
  // menu and the one people reach for by reflex.
  const navigation: ContextMenuSection = [];
  if (target.canGoBack !== false) {
    navigation.push({ id: "back", label: "Back", kind: "back", hint: "Alt+←" });
  }
  navigation.push({ id: "forward", label: "Forward", kind: "forward", hint: "Alt+→" });
  navigation.push({ id: "reload", label: "Reload", kind: "reload", hint: "Ctrl+R" });
  sections.push(navigation);

  const page: ContextMenuSection = [];
  if (target.pageHref) {
    page.push({
      id: "copy-page",
      label: "Copy page link",
      kind: "copy",
      value: target.pageHref,
      copiedMessage: "Page link copied",
    });
  }
  page.push({ id: "print", label: "Print", kind: "print", hint: "Ctrl+P" });
  sections.push(page);

  return sections.filter((section) => section.length > 0);
}

/** Flattened, for keyboard navigation and for counting in tests. */
export function flattenSections(sections: ContextMenuSection[]): ContextMenuAction[] {
  return sections.flat();
}

/**
 * Keep the menu on screen.
 *
 * A native menu flips rather than sliding when it would overflow, because
 * flipping keeps the cursor on the corner it opened from. Sliding is the
 * fallback for a menu taller than the viewport, where flipping cannot help.
 */
export function placeMenu(input: {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): { left: number; top: number } {
  const margin = input.margin ?? 8;
  let left = input.x;
  let top = input.y;

  if (left + input.menuWidth + margin > input.viewportWidth) {
    // Flip to the left of the cursor, unless that puts it off the other edge.
    left = input.x - input.menuWidth;
  }
  if (top + input.menuHeight + margin > input.viewportHeight) {
    top = input.y - input.menuHeight;
  }

  // Whatever the flip produced, never leave the viewport.
  left = Math.max(margin, Math.min(left, input.viewportWidth - input.menuWidth - margin));
  top = Math.max(margin, Math.min(top, input.viewportHeight - input.menuHeight - margin));

  return { left, top };
}
