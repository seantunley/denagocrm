import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { cn } from "../src/lib/utils";

// Sean, 2026-11-02: "the full screen function in the flow builder does not work". The page's own sizing was merged
// after the full-screen classes and won on every desktop screen.
test("full screen wins over the flow builder's own page sizing, on desktop too", () => {
  const shell = readFileSync("src/components/builder-workspace.tsx", "utf8");
  const call = shell.slice(shell.indexOf("className={cn("), shell.indexOf(")}", shell.indexOf("className={cn(")));
  assert.ok(call.indexOf("className,") < call.indexOf("fullscreen &&"), "the full-screen classes come last");

  // What the flow builder actually ends up with, through the same class merge.
  const page = "min-h-[720px] md:h-[calc(100dvh-8rem)] md:min-h-0";
  const merged = cn("flex min-h-[42rem] flex-col rounded-2xl", page, "fixed inset-0 z-[70] h-dvh min-h-0 md:h-dvh md:min-h-0 rounded-none border-0").split(" ");
  for (const kept of ["fixed", "inset-0", "h-dvh", "md:h-dvh", "min-h-0", "rounded-none"]) assert.ok(merged.includes(kept), kept);
  for (const gone of ["md:h-[calc(100dvh-8rem)]", "min-h-[720px]", "rounded-2xl"]) assert.ok(!merged.includes(gone), gone);
});

test("Esc leaves full screen, but not while a dialog is open", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /event\.key === "Escape" && !document\.querySelector\('\[role="dialog"\], \[role="alertdialog"\]'\)\) setFullscreen\(false\)/);
});
