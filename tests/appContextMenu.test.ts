import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextMenu,
  flattenSections,
  focusOnOpen,
  isEditableTarget,
  isKeyboardInvocation,
  placeMenu,
  shouldUseNativeMenu,
  truncate,
} from "../src/lib/appContextMenu";

/**
 * The right-click menu replaces a browser feature, so the tests that matter are
 * the ones about what it must NOT take away.
 */

// ── Standing aside ──────────────────────────────────────────────────────────

test("AN INPUT KEEPS THE NATIVE MENU — Paste cannot be reimplemented", () => {
  /*
   * The single most common right-click in a CRM is "paste a phone number into
   * this field". A web page cannot offer Paste: reading the clipboard needs a
   * permission prompt in Chrome and is refused outright in Firefox. A prettier
   * menu without it is a straight downgrade, so editable targets are declined.
   */
  for (const tagName of ["input", "textarea", "select"]) {
    assert.equal(isEditableTarget({ tagName }), true, `${tagName} must keep the native menu`);
  }
  assert.equal(isEditableTarget({ tagName: "div", isContentEditable: true }), true);

  // Inherited contenteditable: the node under the cursor inside a rich-text
  // editor is usually a plain span, and it is still an editable context.
  assert.equal(isEditableTarget({ tagName: "span", isContentEditable: true }), true);

  // Controls with no text and no Paste are not "editable" for this purpose.
  for (const type of ["checkbox", "radio", "button", "submit", "range", "file"]) {
    assert.equal(isEditableTarget({ tagName: "input", type }), false, `input[type=${type}]`);
  }

  assert.equal(isEditableTarget({ tagName: "div" }), false);
  assert.equal(isEditableTarget({ tagName: "td" }), false);
});

test("A READONLY TEXTAREA KEEPS THE NATIVE MENU TOO — it is still a text field", () => {
  /*
   * This read `!target.readOnly`, so a readonly textarea was classified as NOT
   * editable and lost the browser's menu — and with it Copy, Select all and the
   * browser's selection handling over its contents. Our menu cannot stand in:
   * it copies the page SELECTION, and offers nothing for a caret sitting in a
   * scrollable block of text.
   *
   * It also contradicted the readonly-INPUT rule sitting a few lines below it,
   * which had already reasoned the point out correctly. Readonly fields in this
   * app — generated references, API keys, rendered message bodies — exist
   * precisely to be copied out of, which is the one thing that broke.
   */
  assert.equal(isEditableTarget({ tagName: "textarea", readOnly: true }), true);
  assert.equal(isEditableTarget({ tagName: "textarea", readOnly: false }), true);
  assert.equal(isEditableTarget({ tagName: "TEXTAREA", readOnly: true }), true, "tag case");

  // The same for a readonly text input, for the same reason.
  assert.equal(isEditableTarget({ tagName: "input", type: "text", readOnly: true }), true);
});

test("KEYBOARD-OPENED MENUS ARE DISTINGUISHED FROM RIGHT-CLICKS", () => {
  /*
   * Focus depends on this. A menu opened from the Menu key must start ON an
   * item, or Enter does nothing until an arrow key is pressed — a `role="menu"`
   * that announces itself and then ignores the obvious key. A menu opened by
   * mouse must NOT preselect one: no native menu does, nor does Radix, and a
   * highlighted first row under the cursor is an accidental Enter away from
   * "Open".
   *
   * The Menu key reports button 0 / detail 0; a real right-click reports
   * button 2 with a non-zero detail.
   */
  assert.equal(isKeyboardInvocation({ button: 0, detail: 0 }), true, "Menu key");
  assert.equal(isKeyboardInvocation({ button: 2, detail: 1 }), false, "right-click");
  assert.equal(isKeyboardInvocation({ button: 2, detail: 2 }), false, "second right-click");

  // Long-press on touch also reports 0/0. Treated as keyboard, which costs
  // nothing: the only consequence is that the first item starts focused.
  assert.equal(isKeyboardInvocation({ button: 0, detail: 0 }), true);

  // A synthetic event missing either field must not be mistaken for a mouse
  // right-click — defaulting the other way would reintroduce the dead Enter.
  assert.equal(isKeyboardInvocation({}), true);
  assert.equal(isKeyboardInvocation({ button: 2 }), true, "no detail — assume keyboard");
});

test("A KEYBOARD-OPENED MENU STARTS ON ITS FIRST ITEM, so Enter works at once", () => {
  /*
   * The regression the review caught. The component focused the `role="menu"`
   * container in every case, so someone opening the menu with the Menu key
   * landed on nothing selectable: Enter and Space did nothing until they pressed
   * an arrow key first. A menu that declares role="menu" and implements arrows
   * and Home/End owes the rest of that contract.
   *
   * Exercised through `focusOnOpen`, which is the function the component calls —
   * not by grepping the component for a line that looks right. This repo has
   * already shipped a fix that read correctly in the source and matched nothing
   * at runtime.
   */
  const focused: string[] = [];
  const item = { focus: () => focused.push("item") };
  const container = {
    focus: () => focused.push("container"),
    querySelector: (selector: string) => (selector === "[data-menu-item]" ? item : null),
  };

  assert.equal(focusOnOpen(container, true), "item", "keyboard must land on an item");
  assert.deepEqual(focused, ["item"]);

  // The mouse keeps the container: no native context menu preselects an entry,
  // and a highlighted first row under the cursor is one stray Enter from "Open".
  focused.length = 0;
  assert.equal(focusOnOpen(container, false), "container");
  assert.deepEqual(focused, ["container"]);

  // A menu with no items must still take focus, or Escape stops working.
  focused.length = 0;
  const empty = { focus: () => focused.push("container"), querySelector: () => null };
  assert.equal(focusOnOpen(empty, true), "container");
  assert.deepEqual(focused, ["container"]);
});

test("there is always a first item for keyboard focus to land on", () => {
  // The focus fix depends on the menu never being empty. Even the barest target
  // — no link, no image, no selection, no history — still has actions.
  const bare = flattenSections(buildContextMenu({ canGoBack: false }));
  assert.ok(bare.length > 0, "an empty menu would leave Enter dead again");
  assert.equal(bare[0].id, "forward");
});

test("SHIFT+RIGHT-CLICK ALWAYS REACHES THE BROWSER — the escape hatch", () => {
  // Firefox has always treated Shift as "give me the real menu". Honouring it
  // everywhere means Inspect, Save image as and View source stay one modifier
  // away, app-wide — which is what makes replacing the menu defensible at all.
  assert.equal(
    shouldUseNativeMenu({ editable: false, shiftKey: true, defaultPrevented: false }),
    true,
  );
});

test("A CLICK SOMETHING ELSE ALREADY CLAIMED IS LEFT ALONE", () => {
  /*
   * RecordContextMenu (Radix) owns right-click on 13 pages of record lists and
   * calls preventDefault. The flow canvases do the same. This listener is on
   * `document` in the bubble phase, so it sees those events AFTER they were
   * handled — and must not open a second menu over the top of the first.
   */
  assert.equal(
    shouldUseNativeMenu({ editable: false, shiftKey: false, defaultPrevented: true }),
    true,
  );

  // The ordinary case: nothing claimed it, not editable, no modifier.
  assert.equal(
    shouldUseNativeMenu({ editable: false, shiftKey: false, defaultPrevented: false }),
    false,
  );
});

// ── What the menu offers ────────────────────────────────────────────────────

test("a bare page still gets a useful menu — Back is the reason this exists", () => {
  const sections = buildContextMenu({ pageHref: "https://crm.example/leads" });
  const ids = flattenSections(sections).map((a) => a.id);
  assert.deepEqual(ids, ["back", "forward", "reload", "copy-page", "print"]);
});

test("the first entry in a tab offers no Back", () => {
  const ids = flattenSections(buildContextMenu({ canGoBack: false })).map((a) => a.id);
  assert.equal(ids.includes("back"), false);
  assert.equal(ids.includes("forward"), true);
});

test("a link offers open, new tab and copy — in that order, nearest the cursor", () => {
  const sections = buildContextMenu({
    linkHref: "https://crm.example/contacts/42",
    pageHref: "https://crm.example/contacts",
  });
  // Most specific first: what you clicked ON, before the page it sits in.
  assert.deepEqual(sections[0].map((a) => a.id), ["open", "open-new-tab", "copy-link"]);
});

test("an external link says so, because leaving the CRM should be deliberate", () => {
  const internal = buildContextMenu({ linkHref: "/leads", linkIsExternal: false });
  const external = buildContextMenu({ linkHref: "https://facebook.com", linkIsExternal: true });
  assert.equal(flattenSections(internal).find((a) => a.id === "copy-link")?.label, "Copy link");
  assert.equal(
    flattenSections(external).find((a) => a.id === "copy-link")?.label,
    "Copy external link",
  );
});

test("a selection can be copied, and the label shows what will be copied", () => {
  const sections = buildContextMenu({ selectionText: "  Sipho   Ndlovu  " });
  const copy = flattenSections(sections).find((a) => a.id === "copy-selection");
  assert.equal(copy?.value, "Sipho   Ndlovu", "the value keeps the text as selected, only trimmed");
  assert.equal(copy?.label, "Copy “Sipho Ndlovu”", "the label collapses whitespace to one line");
});

test("a long selection is truncated in the label but copied in full", () => {
  const long = "Unit 4, Waterfall Business Park, Bekker Road, Midrand, Gauteng, 1685";
  const copy = flattenSections(buildContextMenu({ selectionText: long })).find(
    (a) => a.id === "copy-selection",
  );
  assert.equal(copy?.value, long, "the whole address goes to the clipboard");
  assert.ok((copy?.label.length ?? 0) < 40, "but the menu stays one tidy line");
  assert.match(copy?.label ?? "", /…/);
});

test("whitespace alone is not a selection", () => {
  const ids = flattenSections(buildContextMenu({ selectionText: "   \n  " })).map((a) => a.id);
  assert.equal(ids.includes("copy-selection"), false);
});

test("NO 'SEARCH THE WEB' ITEM — a selection here is usually personal information", () => {
  /*
   * The native menu offers it, and it is the one native item deliberately left
   * out. A selection in this app is typically a customer's name, number or
   * address, and that item would put it in a Google URL. This is a POPIA-governed
   * system, and a menu item is not worth an unlogged export of personal data to
   * a third party. Pinned so it is not added later as an obvious omission.
   */
  const everything = buildContextMenu({
    linkHref: "https://crm.example/x",
    imageSrc: "https://crm.example/a.png",
    selectionText: "Thandiwe Mokoena, 082 555 0134",
    pageHref: "https://crm.example/x",
  });
  const labels = flattenSections(everything).map((a) => a.label.toLowerCase());
  for (const label of labels) {
    assert.doesNotMatch(label, /search/, `"${label}" must not offer a web search`);
  }
  const values = flattenSections(everything).map((a) => a.value ?? "");
  for (const value of values) {
    assert.doesNotMatch(value, /google|bing|duckduckgo/i);
  }
});

test("every action carries what it needs to do its job", () => {
  const sections = buildContextMenu({
    linkHref: "https://crm.example/contacts/42",
    imageSrc: "https://crm.example/logo.png",
    selectionText: "hello",
    pageHref: "https://crm.example/contacts",
  });
  for (const action of flattenSections(sections)) {
    // An open or copy with no value is a menu item that silently does nothing.
    if (["open", "open-new-tab", "copy"].includes(action.kind)) {
      assert.ok(action.value, `${action.id} has no value to act on`);
    }
    assert.ok(action.label.trim().length > 0, `${action.id} has no label`);
  }
  // Ids are the React keys — duplicates would drop items from the render.
  const ids = flattenSections(sections).map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate action ids");
});

test("truncate collapses newlines, which would otherwise break the row", () => {
  assert.equal(truncate("one\ntwo"), "one two");
  assert.equal(truncate("short"), "short");
});

// ── Staying on screen ───────────────────────────────────────────────────────

test("A MENU OPENED AT THE EDGE FLIPS RATHER THAN HANGING OFF IT", () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 800, menuWidth: 224, menuHeight: 260 };

  // Room to spare: exactly where the cursor was.
  assert.deepEqual(placeMenu({ x: 100, y: 100, ...viewport }), { left: 100, top: 100 });

  // Near the right edge it flips to the left of the cursor, not slid inward,
  // because flipping keeps the corner under the pointer.
  assert.deepEqual(placeMenu({ x: 950, y: 100, ...viewport }), { left: 950 - 224, top: 100 });

  // Near the bottom, the same upward.
  assert.deepEqual(placeMenu({ x: 100, y: 780, ...viewport }), { left: 100, top: 780 - 260 });
});

test("a menu bigger than the corner it flips into is still fully on screen", () => {
  // Flipping a 260px menu up from y=40 would put it at -220. Clamped instead.
  const placement = placeMenu({
    x: 20,
    y: 40,
    menuWidth: 224,
    menuHeight: 260,
    viewportWidth: 400,
    viewportHeight: 300,
  });
  assert.ok(placement.top >= 8, `top ${placement.top} is off the top of the screen`);
  assert.ok(placement.left >= 8, `left ${placement.left} is off the left of the screen`);
  assert.ok(placement.top + 260 <= 300 + 8, "bottom edge escaped the viewport");
});

test("the menu never sits flush against an edge", () => {
  const flush = placeMenu({
    x: 0,
    y: 0,
    menuWidth: 224,
    menuHeight: 260,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.deepEqual(flush, { left: 8, top: 8 });
});
