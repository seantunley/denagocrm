import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (file: string) => readFileSync(path.join(root, file), "utf8");
const analyticsPage = src("src/app/(app)/bot-analytics/page.tsx");
const analyticsReport = src("src/lib/botFlowAnalyticsReport.ts");
const visualSystem = src("src/components/visual-system.tsx");

test("Flowbot analytics keeps filters and navigation keyboard/touch friendly", () => {
  assert.match(analyticsPage, /aria-label="Analytics filters"/);
  assert.match(analyticsPage, /aria-current=\{flow\.id === selected\?\.id \? "page" : undefined\}/);
  assert.match(analyticsPage, /min-h-11/);
  assert.match(analyticsPage, /aria-live="polite"/);
});

test("Surface forwards semantic section attributes for accessible callers", () => {
  assert.match(visualSystem, /HTMLAttributes<HTMLElement>/);
  assert.match(visualSystem, /\.\.\.props/);
  assert.match(visualSystem, /<section[\s\S]*\{\.\.\.props\}/);
});

test("Flowbot analytics contains wide data instead of overflowing the page", () => {
  assert.match(analyticsPage, /className="min-w-0 space-y-5"/);
  assert.match(analyticsPage, /ResponsiveEntityTable/);
  assert.match(analyticsPage, /max-w-full overflow-x-auto overscroll-x-contain/);
  assert.match(analyticsPage, /break-all font-mono/);
});

test("Flowbot analytics gives charts and tables non-visual labels", () => {
  assert.match(analyticsPage, /aria-label="Scrollable daily analytics chart"/);
  assert.match(analyticsPage, /role="img"/);
  assert.match(analyticsPage, /<caption className="sr-only">Published Flowbot versions/);
  assert.match(analyticsPage, /<caption className="sr-only">Node funnel/);
  assert.match(analyticsPage, /scope="col"/);
});

test("Flowbot analytics surfaces operational attention without changing report calculations", () => {
  assert.match(analyticsPage, /Needs attention/);
  assert.match(analyticsPage, /node\.handoffs > 0 \|\| node\.deliveryFailures > 0/);
  assert.match(analyticsPage, /No node-level handoffs or delivery failures in this view/);
  assert.match(analyticsReport, /export async function getBotFlowAnalyticsReport/);
  assert.doesNotMatch(analyticsPage, /prisma\.botFlowEvent/);
});

test("Flowbot analytics honours reduced-motion and empty-state requirements", () => {
  assert.match(analyticsPage, /motion-reduce:transition-none/);
  assert.match(analyticsPage, /No daily activity matches the current filters/);
  assert.match(analyticsPage, /No successful CRM actions match the current filters/);
  assert.match(analyticsPage, /No runs match the selected filters/);
});
