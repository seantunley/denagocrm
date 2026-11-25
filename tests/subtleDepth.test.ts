import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const depth = code("src/app/depth.css");
/** One utility's body, by name. */
const utility = (name: string) => {
  const start = depth.indexOf(`@utility ${name} {`);
  assert.ok(start >= 0, `@utility ${name} exists`);
  let level = 0;
  for (let i = depth.indexOf("{", start); i < depth.length; i++) {
    if (depth[i] === "{") level++;
    if (depth[i] === "}" && --level === 0) return depth.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
};

test("the depth stylesheet is loaded by the main stylesheet, after Tailwind", () => {
  const globals = read("src/app/globals.css");
  assert.ok(globals.indexOf('@import "./depth.css";') > globals.indexOf('@import "tailwindcss";'));
});

test("nothing moves with reduced motion: the press, the hover lift and the drift are all behind the check", () => {
  for (const name of ["depth-press", "depth-primary"]) {
    const body = utility(name);
    const moving = body.indexOf("transform:");
    assert.ok(moving > 0, `${name} moves`);
    assert.ok(body.lastIndexOf("prefers-reduced-motion: no-preference", moving) > 0, `${name} moves only with motion allowed`);
  }
  assert.match(utility("depth-plane"), /@media \(prefers-reduced-motion: no-preference\) \{\s*animation: depth-drift/);
});

test("a pressed button beats the hover lift it is also under", () => {
  assert.match(utility("depth-press"), /&:active:active:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  assert.match(utility("depth-primary"), /&:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
});

test("a header's scroll shadow needs no script and degrades to flat", () => {
  for (const name of ["depth-scroll-shadow-page", "depth-scroll-shadow-nearest"]) assert.match(utility(name), /@supports \(animation-timeline: scroll\(\)\)/);
  const shell = code("src/components/AppShell.tsx");
  assert.equal(shell.match(/depth-scroll-shadow-page/g)?.length, 2, "both the phone and the desktop header");
  assert.match(code("src/components/Modal.tsx"), /DialogHeader className="sticky top-0[^"]*depth-scroll-shadow-nearest/);
});

test("a card is raised without a background image, so a card made transparent stays flat", () => {
  assert.doesNotMatch(utility("depth-card"), /background/);
  assert.match(read("src/app/globals.css"), /\.card \{\s*\/\*[\s\S]*?\*\/\s*@apply [^;]*bg-card p-4 depth-card;/);
});

test("every button presses, and the shared button component matches the .btn classes", () => {
  const globals = read("src/app/globals.css");
  assert.match(globals, /transition-\[background-color,border-color,color,box-shadow,transform\] duration-150 depth-press/);
  assert.match(globals, /\.btn-primary \{\s*@apply bg-primary text-primary-foreground depth-primary hover:bg-primary\/90;/);
  const button = code("src/components/ui/button.tsx");
  assert.match(button, /transition-\[background-color,border-color,color,box-shadow,transform\]/);
  assert.match(button, /default: "bg-primary text-primary-foreground depth-primary depth-press/);
  // A ghost or link button is text, not a key: it does not sink.
  assert.doesNotMatch(button.match(/ghost:\s*"[^"]*"/)![0], /depth-press/);
  assert.doesNotMatch(button.match(/link: "[^"]*"/)![0], /depth-press/);
});

test("menus, popovers, dialogs and drawers share the floating height", () => {
  for (const file of ["popover", "dropdown-menu", "select", "context-menu", "sheet", "dialog"]) {
    const source = code(`src/components/ui/${file}.tsx`);
    assert.match(source, /depth-float-shadow/, file);
    assert.doesNotMatch(source, /\bshadow-(md|lg)\b/, `${file} has no second, flat shadow`);
  }
  const dialog = code("src/components/ui/dialog.tsx");
  assert.match(dialog, /bg-black\/50 backdrop-blur-\[2px\]/);
  assert.match(dialog, /data-\[state=open\]:zoom-in-97/);
});

test("a held card lifts and the place it will land waits as a well", () => {
  const board = code("src/components/KanbanBoard.tsx");
  assert.match(board, /\? "motion-safe:-rotate-2 motion-safe:scale-\[1\.03\] cursor-grabbing depth-lifted"/);
  assert.match(board, /isOver \? "depth-receiving"/);
  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");
  assert.match(canvas, /motion-safe:-rotate-\[1\.5deg\] motion-safe:scale-\[1\.02\] cursor-grabbing[^"]*depth-lifted/);
  assert.match(canvas, /border-dashed border-primary bg-primary\/10 depth-well/);
});

test("the deal page's vehicle photo is a still, labelled thumbnail with a fallback (no tilting hero)", () => {
  const deal = code("src/app/(app)/deals/[id]/page.tsx");
  // A fixed small box that crops the photo, so a tall or wide picture can't push the page about.
  assert.match(deal, /<div className="grid h-20 w-28 shrink-0 place-items-center overflow-hidden rounded-xl/);
  assert.match(deal, /<img src=\{vehicleImage\} alt=\{vehicleName\} className="size-full object-cover" \/>/);
  // No photo: an icon that a screen reader skips, not an empty box.
  assert.match(deal, /<CarFront className="size-10" strokeWidth=\{1\.5\} aria-hidden="true" \/>/);
  // The tilt went with the hero: nothing left that moves the photo.
  assert.doesNotMatch(deal, /PointerTilt|data-tilt-target|depth-tilt/);
  assert.doesNotMatch(code("src/app/depth.css"), /depth-tilt|--tilt-x/);
});

test("a picked-up card tilts and grows only when motion is allowed; the lift's shadow stays for everyone", () => {
  const kanban = code("src/components/KanbanBoard.tsx");
  assert.match(kanban, /"motion-safe:-rotate-2 motion-safe:scale-\[1\.03\] cursor-grabbing depth-lifted"/);
  assert.match(kanban, /transition-all motion-reduce:transition-none/);
  assert.match(code("src/components/dashboard/editor/DashboardCanvas.tsx"), /motion-safe:-rotate-\[1\.5deg\] motion-safe:scale-\[1\.02\] cursor-grabbing/);
  // No bare drag tilt or grow left behind.
  for (const path of ["src/components/KanbanBoard.tsx", "src/components/dashboard/editor/DashboardCanvas.tsx"]) {
    assert.doesNotMatch(code(path), /(?<![:\w-])-rotate-(?:2|\[1\.5deg\])/, path);
  }
});

test("the sign-in planes are decoration on phones only", () => {
  const planes = code("src/app/login/LoginDepthPlanes.tsx");
  assert.match(planes, /aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden lg:hidden"/);
  assert.match(code("src/app/login/LoginClient.tsx"), /<LoginDepthPlanes \/>/);
});
