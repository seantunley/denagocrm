import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pageSource = readFileSync(join(process.cwd(), "src", "app", "(app)", "leads", "page.tsx"), "utf8");
const boardSource = readFileSync(join(process.cwd(), "src", "components", "KanbanBoard.tsx"), "utf8");
const leadActionsSource = readFileSync(join(process.cwd(), "src", "app", "actions", "leads.ts"), "utf8");

test("lead pipeline activity summaries stay bounded", () => {
  assert.equal(
    pageSource.match(/SELECT DISTINCT ON \("leadId"\)/g)?.length,
    2,
    "expected one bounded query for the next activity and one for the next test drive",
  );
  assert.doesNotMatch(
    pageSource,
    /activities:\s*\{\s*where:\s*\{\s*status:\s*"planned"\s*\},\s*orderBy/,
    "do not restore an unbounded nested planned-activity row load",
  );
});

test("lead pipeline preserves production card signals", () => {
  assert.match(pageSource, /signing:\s*signingByLead\.get\(lead\.id\)/);
  assert.match(pageSource, /stage\.order < testDriveStage\.order/);
  assert.match(pageSource, /stageActionById\.get\(stage\.id\) === "book_test_drive"/);
  assert.match(boardSource, /target\?\.entryAction === "book_test_drive"/);
  assert.doesNotMatch(boardSource, /\/test\/i\.test\(target\.name\)/);
  assert.match(boardSource, /follow-up automation/);
  assert.match(boardSource, /lead\.signing\.label/);
});

test("needs-attention filtering includes overdue work", () => {
  assert.match(
    boardSource,
    /lead\.noNextStep\s*\|\|\s*lead\.nextStep\?\.overdue\s*\|\|/,
    "overdue activities must remain visible when Needs attention is enabled",
  );
});

test("required stage actions cannot be bypassed through the generic move action", () => {
  assert.match(
    leadActionsSource,
    /targetStage\.entryAction === "book_test_drive"[\s\S]+requires test-drive booking details/,
  );
  assert.match(
    leadActionsSource,
    /targetStage\.entryAction !== "book_test_drive"[\s\S]+not configured for test-drive booking/,
  );
  assert.doesNotMatch(leadActionsSource, /\/test\/i\.test\(s\.name\)/);
});
