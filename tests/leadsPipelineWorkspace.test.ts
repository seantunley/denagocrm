import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pageSource = readFileSync(join(process.cwd(), "src", "app", "(app)", "leads", "page.tsx"), "utf8");
const boardSource = readFileSync(join(process.cwd(), "src", "components", "KanbanBoard.tsx"), "utf8");

test("lead pipeline activity summaries stay bounded", () => {
  assert.equal(
    pageSource.match(/SELECT DISTINCT ON \("leadId"\)/g)?.length,
    2,
    "expected one bounded query for the next activity and one for the next test drive",
  );
  assert.doesNotMatch(
    pageSource,
    /activities:\s*\{\s*where:\s*\{\s*status:\s*"planned"\s*\}/,
    "do not restore the unbounded nested planned-activity include",
  );
});

test("lead pipeline preserves production card signals", () => {
  assert.match(pageSource, /signing:\s*signingByLead\.get\(lead\.id\)/);
  assert.match(pageSource, /stage\.order < testDriveStage\.order/);
  assert.match(boardSource, /lead\.signing\.label/);
});

test("needs-attention filtering includes overdue work", () => {
  assert.match(
    boardSource,
    /lead\.noNextStep\s*\|\|\s*lead\.nextStep\?\.overdue\s*\|\|/,
    "overdue activities must remain visible when Needs attention is enabled",
  );
});
