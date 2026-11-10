import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-11-10 (Sean, "do 6"): move a deal's stage from the inbox rail.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("the rail moves a stage through the board's own action, and says when the board must finish it", () => {
  const select = read("src/components/inbox/DealStageSelect.tsx");
  assert.match(select, /import \{ moveLead \} from "@\/app\/actions\/leads";/);
  assert.match(select, /const result = await moveLead\(leadId, next\);/, "no override reason, no remedy guessed");
  assert.match(select, /if \(result\.ok\) \{[\s\S]*router\.refresh\(\);/);
  assert.match(select, /setValue\(before\);\s*if \(result\.error\) toast\.error\(result\.error\);[\s\S]{0,160}else setNeedsBoard\(name\);/, "a refusal goes back and says why");
});

test("only someone who may move stages gets the picker, with the deal's own pipeline's OPEN stages", () => {
  const page = read("src/app/(app)/inbox/page.tsx");
  assert.match(page, /hasPermission\(user, "leads\.change_stage"\)/);
  assert.match(page, /const pipelineIds = canChangeStage \?/);
  assert.match(page, /\(await listPipelineStages\(pipelineId\)\)\.filter\(\(stage\) => !stage\.isClosed\)/, "won/lost stay with Mark won / Mark lost");
  assert.match(page, /stageOptions: deal\.status === "open" \? openStages\.get\(deal\.stage\.pipelineId\) \?\? \[\] : \[\],/);
  const rail = read("src/components/SocialThreadList.tsx");
  assert.match(rail, /deal\.status === "open" && deal\.stageOptions\.length > 1\s*\? <DealStageSelect/);
});
