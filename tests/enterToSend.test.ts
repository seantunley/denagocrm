import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ENTER_SENDS_KEY,
  enterIntent,
  readEnterSends,
  writeEnterSends,
  type EnterKey,
} from "../src/lib/enterToSend";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Enter sends; Alt+Enter starts a new line.
 *
 * The interesting part is not the happy path, it is the keypresses that must NOT
 * send — and one of them is invisible to anyone testing in English.
 */

const key = (over: Partial<EnterKey> = {}): EnterKey => ({
  key: "Enter",
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...over,
});

test("Enter sends, and that is the default", () => {
  assert.equal(enterIntent(key(), true), "send");
  // The default is what an absent preference resolves to, not just what the
  // component happens to initialise with.
  assert.equal(readEnterSends({ getItem: () => null }), true);
});

test("Alt+Enter and Shift+Enter make a new line", () => {
  assert.equal(enterIntent(key({ altKey: true }), true), "newline");
  // Shift+Enter is supported as well as the requested Alt+Enter: it is the
  // convention people's hands already know, and breaking it would surprise them.
  assert.equal(enterIntent(key({ shiftKey: true }), true), "newline");
});

test("an IME's Enter belongs to the IME, never to us", () => {
  // Typing Chinese, Japanese or Korean uses Enter to accept the candidate word.
  // Sending on that key makes the inbox unusable in those languages, and nobody
  // testing in English would ever see it.
  assert.equal(enterIntent(key({ isComposing: true }), true), "ignore");
  assert.equal(enterIntent(key({ isComposing: true }), false), "ignore");
});

test("with the preference off, Enter never sends", () => {
  assert.equal(enterIntent(key(), false), "newline");
  assert.equal(enterIntent(key({ altKey: true }), false), "newline");
  // Ctrl/Cmd+Enter is "send" in enough apps that it must not quietly insert a
  // newline for someone who turned the default off.
  assert.equal(enterIntent(key({ ctrlKey: true }), false), "send");
  assert.equal(enterIntent(key({ metaKey: true }), false), "send");
});

test("other keys are not our business", () => {
  for (const k of ["a", "Tab", "Escape", "NumpadEnter"]) {
    assert.equal(enterIntent(key({ key: k }), true), "ignore", `${k} must be ignored`);
  }
});

test("the preference round-trips, and a corrupt value falls back to the default", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  writeEnterSends(storage, false);
  assert.equal(store.get(ENTER_SENDS_KEY), "false");
  assert.equal(readEnterSends(storage), false);

  writeEnterSends(storage, true);
  assert.equal(readEnterSends(storage), true);

  // Only an explicit "false" turns it off. Anything else is the documented
  // default, so a corrupted value cannot silently change what the key does.
  store.set(ENTER_SENDS_KEY, "banana");
  assert.equal(readEnterSends(storage), true);
});

test("blocked storage does not break the keyboard", () => {
  // localStorage throws outright when cookies are blocked. A preference that
  // cannot be saved is survivable; a keypress that throws is not.
  const throwing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  assert.equal(readEnterSends(throwing), true);
  assert.doesNotThrow(() => writeEnterSends(throwing, false));
  assert.equal(readEnterSends(null), true);
  assert.equal(readEnterSends(undefined), true);
});

/** Wiring: the rule is useless if the reply box does not apply it. */

test("the reply box uses the shared rule and submits the real form", () => {
  const code = src("src/components/InboxReply.tsx");
  assert.match(code, /onKeyDown=\{onKeyDown\}/, "the textarea must be wired");
  assert.match(code, /enterIntent\(/, "and use the shared rule rather than its own if-statement");
  assert.match(code, /isComposing/, "including the IME guard");
  // requestSubmit runs the form's own handlers and validation, so the key behaves
  // exactly like pressing Send. submit() would bypass both.
  assert.match(code, /formRef\.current\?\.requestSubmit\(\)/);
  assert.doesNotMatch(code, /formRef\.current\?\.submit\(\)/);
});

test("the preference is read after mount, not during render", () => {
  // localStorage does not exist on the server; reading it while rendering would
  // make the first client paint disagree with the server markup.
  const code = src("src/components/InboxReply.tsx");
  assert.match(code, /useState\(true\)/, "it must start at the documented default");
  assert.match(code, /useEffect\(\(\) => \{\s*setEnterSends\(readEnterSends\(/);
});

test("the checkbox exists and says what the other key does", () => {
  const code = src("src/components/InboxReply.tsx");
  assert.match(code, /type="checkbox"/);
  assert.match(code, /checked=\{enterSends\}/);
  assert.match(code, /writeEnterSends\(/, "toggling must persist");
  assert.match(code, /Enter sends/, "the label must name the behaviour");
  assert.match(code, /for a new line/, "and tell you the other key");
});

/**
 * …AND IT MUST NOT SEND THE SAME MESSAGE TWELVE TIMES.
 *
 * Reported in review. Holding Enter auto-repeats keydown, and every repeat sent.
 * In an internal text box that is untidy; over WhatsApp and Messenger it is a
 * dozen copies of one message to a customer, which cannot be unsent.
 *
 * The component was also discarding useActionState's third value — the pending
 * flag — so two keystrokes 50ms apart were two submits before the first returned.
 */

test("a HELD Enter sends once, not once per repeat", () => {
  assert.equal(enterIntent(key(), true), "send", "the first keydown sends");
  assert.equal(enterIntent(key({ repeat: true }), true), "ignore", "every repeat after it does not");
  // And a repeat is ignored rather than turned into a newline — holding Enter
  // should do nothing at all, not fill the box with blank lines.
  assert.equal(enterIntent(key({ repeat: true, altKey: true }), true), "ignore");
  assert.equal(enterIntent(key({ repeat: true }), false), "ignore");
});

test("nothing sends while a send is already in flight", () => {
  assert.equal(enterIntent(key(), true, true), "ignore");
  assert.equal(enterIntent(key({ ctrlKey: true }), false, true), "ignore");
  // Not even a newline: the box is mid-submit and about to be cleared.
  assert.equal(enterIntent(key({ altKey: true }), true, true), "ignore");
  // The default stays false, so nothing that omits the argument changes meaning.
  assert.equal(enterIntent(key(), true), "send");
});

test("the component supplies both guards from the real event", () => {
  const code = src("src/components/InboxReply.tsx");
  assert.match(code, /repeat: event\.repeat/, "the browser's own repeat flag");
  assert.match(code, /waAction, waPending/, "useActionState's pending value must not be discarded");
  assert.match(code, /dmAction, dmPending/);
  assert.match(code, /enterIntent\(\s*\{[\s\S]*?\},\s*enterSends,\s*pending,\s*\)/,
    "and both must reach the rule");
});
