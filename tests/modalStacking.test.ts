import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...tsxFiles(rel));
    else if (entry.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * A full-screen overlay must be PORTALLED, or its z-index means nothing.
 *
 * ── THE BUG THIS GUARDS ─────────────────────────────────────────────────────
 *
 * `z-index` orders siblings within a stacking context, and a long list of
 * ordinary CSS properties silently creates one — `transform`, `filter`,
 * `backdrop-filter`, `opacity` below 1, `will-change`, `contain`, or a
 * positioned ancestor with its own `z-index`.
 *
 * The app shell's top bar is `fixed … z-30 … backdrop-blur-xl`. An overlay
 * rendered inline in the page tree therefore competes only inside whatever box
 * its ancestors established, never with the bar — so the clock/weather strip
 * painted straight across the top of an open "Send email" dialog.
 *
 * Raising the number does not fix it. That the ten hand-rolled overlays had
 * drifted to z-40, z-50, z-[60], z-[70] and z-[100] is the evidence: each was
 * bumped until it looked right on one screen, and none of them was competing
 * with the bar at all.
 *
 * The shared `Dialog` never had the bug, because Radix portals it.
 */

/** Overlays that are deliberately NOT modals. */
const NOT_A_MODAL: ReadonlySet<string> = new Set([
  // A workspace container that goes fullscreen. It IS the page content, so
  // portalling it to <body> would tear it out of the layout it belongs to.
  "src/components/builder-workspace.tsx",
]);

/** The primitives that portal for themselves. */
const PORTALS_ITSELF = /components\/ui\/(dialog|sheet|alert-dialog|drawer|popover|tooltip|dropdown-menu|modal-portal)\.tsx$/;

const OVERLAY = /fixed inset-0 z-/;

test("every hand-rolled full-screen overlay is rendered through a portal", () => {
  const offenders = [...tsxFiles("src/components"), ...tsxFiles("src/app")]
    .filter((rel) => !NOT_A_MODAL.has(rel))
    .filter((rel) => !PORTALS_ITSELF.test(rel))
    .filter((rel) => OVERLAY.test(read(rel)))
    .filter((rel) => !/ModalPortal|createPortal|DialogPortal/.test(read(rel)));

  assert.deepEqual(
    offenders,
    [],
    "These render a full-screen overlay inline, so their z-index is trapped in an " +
      "ancestor stacking context and the app shell's top bar paints over them. " +
      "Wrap the overlay in <ModalPortal> (src/components/ui/modal-portal.tsx), or " +
      "use the shared <Dialog>:\n  " + offenders.join("\n  "),
  );
});

test("the portal renders nothing until the client has hydrated", () => {
  // A portal emitted during SSR/hydration is a markup mismatch. An overlay is
  // only ever visible after an interaction, so waiting costs nothing.
  const source = read("src/components/ui/modal-portal.tsx");
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /if \(!hydrated\) return null;/);
});

test("the ten overlays that had the bug are all portalled", () => {
  // Named individually, because a regression here is invisible until somebody
  // opens the right dialog on the right page.
  for (const rel of [
    "src/components/CameraCapture.tsx",
    "src/components/EmailComposer.tsx",
    "src/components/KanbanBoard.tsx",
    "src/components/PhotoAnnotator.tsx",
    "src/components/ProofOfDelivery.tsx",
    "src/components/SetAsideAttentionButton.tsx",
    "src/components/TestDriveWeather.tsx",
    "src/components/doceditor/VersionHistory.tsx",
    "src/components/signing/SignatureCapture.tsx",
    "src/components/signing/SignedDocPreview.tsx",
  ]) {
    assert.match(read(rel), /<ModalPortal>/, `${rel} must portal its overlay`);
  }
});
