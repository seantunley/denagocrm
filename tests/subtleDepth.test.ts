import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tiltFromPointer } from "../src/lib/pointerTilt";

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

const rect = { left: 100, top: 50, width: 200, height: 100 };

test("the photo turns toward the pointer, at most the given degrees at the edge", () => {
  assert.deepEqual(tiltFromPointer(rect, 200, 100, 3), { x: 0, y: 0 });
  assert.deepEqual(tiltFromPointer(rect, 300, 50, 3), { x: 3, y: 3 });
  assert.deepEqual(tiltFromPointer(rect, 100, 150, 3), { x: -3, y: -3 });
  assert.deepEqual(tiltFromPointer(rect, 250, 75, 4), { x: 2, y: 2 });
});

test("a pointer outside the panel, an empty panel, or no allowance never turns it further", () => {
  assert.deepEqual(tiltFromPointer(rect, 9999, -9999, 3), { x: 3, y: 3 });
  assert.deepEqual(tiltFromPointer({ ...rect, width: 0 }, 200, 100, 3), { x: 0, y: 0 });
  assert.deepEqual(tiltFromPointer(rect, 300, 50, 0), { x: 0, y: 0 });
  assert.ok(!Object.is(tiltFromPointer(rect, 200, 100, 3).x, -0), "no negative zero in a CSS value");
});

test("the depth stylesheet is loaded by the main stylesheet, after Tailwind", () => {
  const globals = read("src/app/globals.css");
  assert.ok(globals.indexOf('@import "./depth.css";') > globals.indexOf('@import "tailwindcss";'));
});

test("nothing moves with reduced motion: the press, the hover lift, the tilt and the drift are all behind the check", () => {
  for (const name of ["depth-press", "depth-primary"]) {
    const body = utility(name);
    const moving = body.indexOf("transform:");
    assert.ok(moving > 0, `${name} moves`);
    assert.ok(body.lastIndexOf("prefers-reduced-motion: no-preference", moving) > 0, `${name} moves only with motion allowed`);
  }
  assert.match(utility("depth-tilt"), /@media \(hover: hover\) and \(pointer: fine\) and \(prefers-reduced-motion: no-preference\) \{[\s\S]*transform: perspective/);
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
  assert.match(board, /\? "-rotate-2 scale-\[1\.03\] cursor-grabbing depth-lifted"/);
  assert.match(board, /isOver \? "depth-receiving"/);
  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");
  assert.match(canvas, /-rotate-\[1\.5deg\] scale-\[1\.02\] cursor-grabbing[^"]*depth-lifted/);
  assert.match(canvas, /border-dashed border-primary bg-primary\/10 depth-well/);
});

test("the vehicle photo tilts only for a mouse, from the whole panel", () => {
  const tilt = code("src/components/PointerTilt.tsx");
  assert.match(tilt, /if \(event\.pointerType !== "mouse"/);
  assert.match(tilt, /onPointerLeave=\{\(\) => set\("0deg", "0deg"\)\}/);
  const deal = code("src/app/(app)/deals/[id]/page.tsx");
  assert.match(deal, /<img src=\{vehicleImage\} alt=\{vehicleName\} data-tilt-target/);
  assert.match(deal, /<PointerTilt className="relative overflow-hidden/);
});

test("the sign-in planes are decoration on phones only", () => {
  const planes = code("src/app/login/LoginDepthPlanes.tsx");
  assert.match(planes, /aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden lg:hidden"/);
  assert.match(code("src/app/login/LoginClient.tsx"), /<LoginDepthPlanes \/>/);
});
