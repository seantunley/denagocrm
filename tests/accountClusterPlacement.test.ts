import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Help, Settings and the account menu moved out of the sidebar footer to the
 * top-right, which returns the footer's height to the nav — the thing that runs
 * out of room as modules are added.
 *
 * The risk in a move like this is not that it looks wrong. It is that a control
 * becomes unreachable on one breakpoint, or that the two placements drift into
 * two different menus.
 */

test("the cluster is defined once and used by both bars", () => {
  // Two copies of a menu containing "Sign out" is the kind of thing that drifts:
  // one gains an item and the other quietly does not.
  const shell = src("src/components/AppShell.tsx");
  assert.equal((shell.match(/function AccountCluster\(/g) ?? []).length, 1);
  assert.equal((shell.match(/<AccountCluster /g) ?? []).length, 2, "desktop bar and mobile header");

  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /Sign out/);
  assert.doesNotMatch(shell, /Sign out/, "the shell must not carry a second copy of the menu");
});

test("the account menu is reachable on every breakpoint", () => {
  const shell = src("src/components/AppShell.tsx");
  const desktopBar = shell.slice(shell.indexOf("{/* Desktop top bar"), shell.indexOf("{/* Mobile drawer */}"));
  const mobileBar = shell.slice(shell.indexOf("{/* Mobile top bar"), shell.indexOf("{/* Desktop top bar"));

  // Desktop: shown only at lg, because the mobile header covers the rest.
  assert.match(desktopBar, /hidden h-14 items-center[^"]*lg:flex/);
  assert.match(desktopBar, /<AccountCluster /);
  // Mobile: the same cluster, on the header that already existed.
  assert.match(mobileBar, /lg:hidden/);
  assert.match(mobileBar, /<AccountCluster /);
});

test("the sidebar footer is gone, not merely hidden", () => {
  // Leaving it rendered would keep the height it was taking, which is the whole
  // point of the move.
  const shell = src("src/components/AppShell.tsx");
  const sidebar = shell.slice(shell.indexOf("function SidebarInner("), shell.indexOf("export default function AppShell"));
  assert.doesNotMatch(sidebar, /Help, Settings & user/);
  assert.doesNotMatch(sidebar, /<SidebarHelpSettings/, "the sidebar no longer carries these");
  assert.doesNotMatch(sidebar, /<AccountMenu/);
  // The nav keeps its scroll region, which is what gains the space.
  assert.match(sidebar, /flex-1 overflow-y-auto/);
});

test("the page reserves the height the fixed bar takes", () => {
  // A fixed bar over unpadded content hides the first rows of every page.
  const shell = src("src/components/AppShell.tsx");
  assert.match(shell, /fixed left-60 right-0 top-0 z-30[^"]*h-14/, "bar is fixed, and to the right of the sidebar");
  assert.match(shell, /lg:pt-19/, "content clears it");
});

test("ClockWeather moved rather than being duplicated or dropped", () => {
  const shell = src("src/components/AppShell.tsx");
  assert.equal((shell.match(/<ClockWeather /g) ?? []).length, 1, "exactly one instance");
  const desktopBar = shell.slice(shell.indexOf("{/* Desktop top bar"), shell.indexOf("{/* Mobile drawer */}"));
  assert.match(desktopBar, /<ClockWeather cities=\{weatherCities\}/, "and it lives in the bar now");
});

test("the compact variant is a trigger change, not a second menu", () => {
  // The panels must stay identical — only the trigger and the side they open
  // from differ, because a bar at the top cannot open a menu upwards.
  const help = src("src/components/SidebarHelpSettings.tsx");
  assert.match(help, /compact \? ICON_TRIGGER : ROW/);
  assert.match(help, /const panelSide = compact \? "bottom" : "right"/);
  assert.equal((help.match(/side=\{panelSide\}/g) ?? []).length, 2, "Help and Settings panels both");

  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /side=\{compact \? "bottom" : "top"\}/);
});

test("the compact triggers are icon-only", () => {
  // The Settings trigger kept its ChevronRight while Help lost it, so the chevron
  // wrapped under the icon inside an 8x8 grid button — a stray ">" below the gear.
  // Both affordances belong to the sidebar row, where there is a label to point at.
  const help = src("src/components/SidebarHelpSettings.tsx");
  const triggers = help.slice(help.indexOf("const triggerClass ="), help.indexOf("const settingsGroups") > 0 ? help.length : help.length);
  const chevrons = triggers.match(/<ChevronRight className="size-3\.5 text-muted-foreground\/50/g) ?? [];
  const guarded = triggers.match(/\{!compact && <ChevronRight className="size-3\.5 text-muted-foreground\/50/g) ?? [];
  assert.equal(chevrons.length, guarded.length, "every trigger chevron must be hidden when compact");
  assert.equal(guarded.length, 2, "Help and Settings");
});

test("the cluster reads as one object", () => {
  const shell = src("src/components/AppShell.tsx");
  const cluster = shell.slice(shell.indexOf("function AccountCluster("), shell.indexOf("function SidebarInner("));
  assert.match(cluster, /rounded-xl border border-sidebar-border\/70/, "a hairline holds it together");
  assert.match(cluster, /bg-sidebar-accent\/25/, "and a barely-there fill");
  // Subtle means it must not read as a button or compete with the page.
  assert.doesNotMatch(cluster, /bg-primary|shadow-lg|border-primary/);
});

test("an avatar-only trigger still says who you are", () => {
  // The sidebar showed the name next to the avatar. Behind an avatar alone it
  // has to be in the menu, or you cannot tell which account you are signed into.
  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /aria-label=\{`Account — \$\{user\.name\}`\}/);
  const compactHeader = menu.slice(menu.indexOf("{compact && ("), menu.indexOf("v{APP_VERSION}"));
  assert.match(compactHeader, /\{user\.name\}/);
  assert.match(compactHeader, /\{user\.role\}/);
  // The icon-only Help/Settings triggers need names too.
  const help = src("src/components/SidebarHelpSettings.tsx");
  assert.match(help, /aria-label=\{compact \? "Help" : undefined\}/);
  assert.match(help, /aria-label=\{compact \? "Settings" : undefined\}/);
});

test("your own account is reachable from the menu, not just the workspace's", () => {
  // "Settings" alone meant opening the workspace settings and finding the right
  // tab. The password form sat collapsed inside that tab as well, so arriving on
  // the page still left it to be found.
  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /href="\/settings\?tab=account"[\s\S]{0,80}My profile/);
  assert.match(menu, /href="\/settings\?tab=account&section=password#password"[\s\S]{0,90}Change password/);
  // Personal items come before the workspace-wide ones.
  assert.ok(menu.indexOf("My profile") < menu.indexOf("Workspace settings"));
  assert.ok(menu.indexOf("Change password") < menu.indexOf("Workspace settings"));
  // Sign out stays last among the actions; the version is reference, not an action.
  assert.ok(menu.indexOf("Sign out") < menu.indexOf("APP_VERSION}</DropdownMenuLabel>"));
});

test("the password section opens when it is linked to", () => {
  // A <details> that arrives closed has not answered the request.
  const page = src("src/app/(app)/settings/page.tsx");
  assert.match(page, /searchParams: Promise<\{ tab\?: string; section\?: string \}>/);
  assert.match(page, /const \{ tab: rawTab, section \} = await searchParams;/);
  assert.match(page, /<details id="password" open=\{section === "password"\}>/);
});

/**
 * The mobile header, as geometry.
 *
 * The first version centred the logo with `justify-center` and floated the
 * cluster over it with `absolute right-2`. An absolutely-positioned element
 * reserves NO layout space, so nothing stopped the two from occupying the same
 * pixels — and BrandLogo's fallback is the workspace NAME, `whitespace-nowrap`,
 * bounded at 120 characters. On a 375px screen an ordinary wordmark ran straight
 * under the controls.
 *
 * This is not a browser test: there is no viewport harness in this repo
 * (puppeteer-core is here only to render guide PDFs). So the fix is made
 * STRUCTURAL rather than tuned — three real columns, the outer two a fixed equal
 * width, the centre `min-w-0 overflow-hidden` — and what is asserted below is
 * that contract plus the arithmetic that makes it hold at the narrowest
 * supported width. A layout that cannot overlap beats a measurement that happened
 * not to.
 */

const REM = 16;
const SIDE_COLUMN_REM = 7.5;
const NARROWEST_PHONE = 320; // smaller than the 375 the report used

test("the mobile header columns fit the narrowest phone with the centre still positive", () => {
  const side = SIDE_COLUMN_REM * REM;            // 120px
  const padding = 2 * (0.5 * REM);               // px-2 either side
  const gaps = 2 * (0.5 * REM);                  // gap-2 between three columns
  const centre = NARROWEST_PHONE - side * 2 - padding - gaps;

  assert.ok(centre > 0, `centre column collapses at ${NARROWEST_PHONE}px (got ${centre}px)`);
  // The cluster is ~115px of controls; its column must actually hold them.
  assert.ok(side >= 115, `cluster column ${side}px cannot hold ~115px of controls`);
});

test("the cluster occupies a column instead of floating over the logo", () => {
  const shell = src("src/components/AppShell.tsx");
  const mobileBar = shell.slice(shell.indexOf("{/* Mobile top bar"), shell.indexOf("{/* Desktop top bar"));

  // The defect: absolute positioning reserves no space.
  assert.doesNotMatch(mobileBar, /absolute right-2/, "an absolutely-positioned cluster cannot reserve space");
  // The HEADER element itself must lay columns out, not centre one child. The
  // centre column still uses justify-center — to centre the logo inside itself.
  const headerTag = mobileBar.slice(mobileBar.indexOf("<header"), mobileBar.indexOf(">", mobileBar.indexOf("<header")));
  assert.doesNotMatch(headerTag, /justify-center/, "the header must not centre a single child");
  assert.match(headerTag, /flex h-12 items-center gap-2/);

  // Two equal, non-shrinking outer columns keep the logo optically centred.
  assert.equal((mobileBar.match(/w-\[7\.5rem\] shrink-0/g) ?? []).length, 2, "matched side columns");
  // And the centre must be able to shrink AND clip, or a long wordmark still wins.
  assert.match(mobileBar, /flex min-w-0 flex-1 justify-center overflow-hidden/);
  assert.match(mobileBar, /className="h-6 w-auto max-w-full object-contain"/);
});

/**
 * A successful upload has to end the "pending pick" state.
 *
 * `preview` is what offers Save and hides Remove, and the server action cannot
 * clear it: revalidatePath refreshes the SERVER props, and this client
 * component's local state survives that untouched. So the screen kept saying
 * "Save photo" after the photo was already saved, kept offering it once the form
 * had reset and there was no file behind it, kept Remove hidden, and held the old
 * object URL alive.
 */

/** The component's own rule for which photo controls are showing. */
function photoControls(state: { preview: string | null; hasAvatar: boolean }) {
  return {
    save: Boolean(state.preview),
    remove: state.hasAvatar && !state.preview,
  };
}

test("choosing, saving and removing a photo moves through the right controls", () => {
  // No photo yet.
  let s = { preview: null as string | null, hasAvatar: false };
  assert.deepEqual(photoControls(s), { save: false, remove: false });

  // Pick a file: Save appears.
  s = { preview: "blob:new", hasAvatar: false };
  assert.deepEqual(photoControls(s), { save: true, remove: false });

  // Upload succeeds. The effect clears preview; the server props now say hasAvatar.
  s = { preview: null, hasAvatar: true };
  assert.deepEqual(photoControls(s), { save: false, remove: true },
    "Save must go and Remove must come back once the photo is saved");

  // Leaving preview set — the defect — offers Save with nothing behind it.
  assert.deepEqual(photoControls({ preview: "blob:new", hasAvatar: true }), { save: true, remove: false });
});

test("the upload effect clears and revokes the preview, and resets the form", () => {
  const forms = src("src/components/ProfileSettingsForms.tsx");
  const effect = forms.slice(forms.indexOf("if (!photoState.ok) return;"), forms.indexOf("const avatarSrc"));
  assert.match(effect, /URL\.revokeObjectURL\(previous\)/, "the old object URL must not leak");
  assert.match(effect, /return null;/, "and preview must actually clear");
  assert.match(effect, /formRef\.current\?\.reset\(\)/, "the file input must not keep a stale selection");
  assert.match(forms, /\}, \[photoState\]\);/, "keyed on the action result, not on render");
});

test("the format guidance is readable without a hover", () => {
  // It had been moved into a title attribute. A phone has no hover, so that is
  // the one place this guidance cannot be read.
  const forms = src("src/components/ProfileSettingsForms.tsx");
  assert.match(forms, /JPG, PNG or WebP · max 3 MB/);
  assert.doesNotMatch(forms, /title="JPG, PNG or WebP/);
});
