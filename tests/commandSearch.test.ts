import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The one search box in the product searched no records at all.
 *
 * `CommandMenu` filtered static lists — nav pages, settings entries, quick
 * actions — while its placeholder read "Search…" and the mobile nav's Search
 * button opened it. Typing a customer's name returned "No results found": not
 * "look over there", a confident nothing. The full-page search at /search did
 * the real work, and nothing pointed at it.
 *
 * Source-patterned, and says so: the palette is a client component reaching a
 * "use server" module, which node:test cannot import.
 */

const action = src("src/app/actions/search.ts");
const menu = src("src/components/CommandMenu.tsx");
const menuCode = shipped("src/components/CommandMenu.tsx");

test("the palette searches records, not just navigation", () => {
  assert.ok(menuCode.includes("searchRecords("), "the palette must query records");
  assert.ok(menuCode.includes("MIN_SEARCH_TERM"), "and share the server's minimum term");
  // The one search field in the product should say what it searches.
  assert.ok(
    !/placeholder="Search pages, settings, or actions/.test(menu),
    "the placeholder must not still describe a navigation-only box",
  );
  assert.match(menu, /placeholder="Search customers, leads, quotes, pages/);
});

test("record hits are rendered above the navigation groups", () => {
  // Somebody typing a name wants the customer, not the page whose title happens
  // to share a letter with it.
  // The headings moved into `SEARCH_GROUPS` when the shared module was extracted,
  // so the marker is the group render itself rather than the old lookup table.
  const records = menuCode.indexOf("heading={group.heading}");
  const quickActions = menuCode.indexOf('heading="Quick actions"');
  const settings = menuCode.indexOf('heading="Settings"');
  assert.ok(records >= 0, "records must be rendered");
  assert.ok(records < quickActions, "records come before quick actions");
  assert.ok(records < settings, "records come before settings");
});

test("the client does not re-filter what the server already matched", () => {
  // `cmdk` scores every item against the typed text and hides what it dislikes.
  // The server matched fields the label never shows — an email, a VIN, a phone
  // number — so a client-side re-score would hide a correct hit. Including the
  // term in the item's value makes every server hit a match.
  assert.match(menuCode, /value=\{`record \$\{hit\.type\} \$\{hit\.id\} \$\{term\}`\}/);
});

test("a slow keystroke cannot repaint over a newer one", () => {
  // "sm" can answer after "smith". Without a guard the older, wider result set
  // lands on top of the newer one and the box lies about what it searched.
  assert.match(menuCode, /latest\.current = query/);
  assert.match(menuCode, /if \(latest\.current !== query\) return/);
  // Debounced, or every keystroke is a round trip.
  assert.match(menuCode, /setTimeout\(/);
  assert.match(menuCode, /clearTimeout\(timer\)/);
});

test("a failed lookup leaves the palette usable as a menu", () => {
  // The navigation half must survive a search that errored — the palette is how
  // people get around, not only how they search.
  const catchBlock = menuCode.slice(menuCode.indexOf(".catch("), menuCode.indexOf(".finally("));
  assert.ok(catchBlock.includes("setHits([])"), "a failure clears results");
  assert.ok(!catchBlock.includes("setOpen"), "and must not close the palette");
});

test("every close path clears the search, not just the dialog's own", () => {
  // The reset lived in one function and TWO other paths bypassed it: `go()` closed
  // with `setOpen(false)` after selecting anything, and the Cmd-K toggle flipped
  // `setOpen` directly. Either way the next open showed the previous search
  // before a key was pressed.
  //
  // Asserted as an ABSENCE: `setOpen` may be called in exactly one place, inside
  // the function that owns the reset. Anything else is a fourth route waiting to
  // be added.
  const calls = (menuCode.match(/setOpen\(/g) ?? []).length;
  assert.equal(calls, 1, "setOpen must be called only by setPaletteOpen");
  const owner = menuCode.slice(menuCode.indexOf("function setPaletteOpen("));
  assert.ok(owner.indexOf("setOpen(next)") < owner.indexOf("}"), "and that one call is the owner's");

  assert.match(menuCode, /function go\(href: string\) \{\s+setPaletteOpen\(false\);/);
  assert.match(menuCode, /setPaletteOpen\(!openRef\.current\)/, "the shortcut toggles through the same path");
  assert.match(menuCode, /const onOpen = \(\) => setPaletteOpen\(true\)/);
});

test("the keyboard shortcut reads a ref, not a stale closure", () => {
  // The listener is registered once, so it closes over the first render's `open`.
  assert.match(menuCode, /const openRef = useRef\(false\)/);
  assert.match(menuCode, /openRef\.current = open/);
});

test("nothing but an async function is exported from the action module", () => {
  // A "use server" module may export ONLY async functions; every other export
  // becomes a client-callable endpoint and Next refuses the file. `tsc` cannot
  // see that rule — this shipped a red build once for exactly this.
  const exports = [...shipped("src/app/actions/search.ts").matchAll(/^export\s+(\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports, ["async"], `unexpected exports from a "use server" module: ${exports.join(", ")}`);
  // The shared constant and type therefore live in a plain module both sides import.
  assert.match(menuCode, /from "@\/lib\/recordSearch"/);
  assert.match(shipped("src/app/actions/search.ts"), /from "@\/lib\/recordSearch"/);
});

test("there is still a way to reach everything the palette does not show", () => {
  // The palette is a shortlist: five types, five each. Documents, products and
  // custom-field matches live on /search, and the shortlist has to admit that.
  assert.match(menuCode, /\/search\?q=\$\{encodeURIComponent\(term\.trim\(\)\)\}/);
});

/* ── the action ─────────────────────────────────────────────────────────── */

test("the search action binds a tenant scope", () => {
  // A Server Action does not inherit the scope a page render establishes, and
  // every read here is tenant-guarded — so without this it throws under
  // enforcement instead of returning results. Third time this has bitten: the
  // research action, the push test, and it would have been this.
  assert.match(action, /return withActingStaffScope\(async \(\) => \{/);
});

test("results are scoped by the shared permission helpers, not a new resolver", () => {
  // A second scope resolver written for a search box is how a search box becomes
  // the way to read records you cannot open.
  for (const helper of [
    "getAccessibleContactIds",
    "getAccessibleLeadIds",
    "getAccessibleQuoteIds",
    "getAccessibleVehicleIds",
    "getAccessibleJobCardIds",
  ]) {
    assert.ok(action.includes(`${helper}(user)`), `${helper} must scope its type`);
  }
  // The documented contract: null means unrestricted, [] must become an
  // IMPOSSIBLE match rather than an absent filter.
  assert.match(action, /const scoped = \(ids: string\[\] \| null\) => \(ids === null \? \{\} : \{ id: \{ in: ids \} \}\)/);
  assert.match(action, /const empty = \(ids: string\[\] \| null\) => ids !== null && ids\.length === 0/);
  const code = shipped("src/app/actions/search.ts");
  // Every entity must consult `empty` before querying, or an empty allow-list
  // silently becomes "everything".
  assert.equal((code.match(/empty\([a-zA-Z]+Ids\)/g) ?? []).length, 5, "every type must honour the empty contract");
});

test("module-gated types are not searched when their pack is off", () => {
  // Surfacing a vehicle for a workspace with automotive switched off offers a
  // record they have no screen to open.
  assert.match(shipped("src/app/actions/search.ts"), /!automotiveOn \|\| empty\(vehicleIds\)/);
  assert.match(shipped("src/app/actions/search.ts"), /!automotiveOn \|\| empty\(jobCardIds\)/);
});

test("the mobile Search button opens this palette", () => {
  // The report was specifically about the mobile app, so the entry point is
  // pinned: if the button ever stops opening the command menu, this fix stops
  // reaching the place it was reported from.
  const mobile = src("src/components/MobileCompanionNav.tsx");
  assert.match(mobile, /onClick=\{openCommandMenu\}/);
  assert.match(mobile, /import \{ openCommandMenu \} from "@\/components\/CommandMenu"/);
});
