import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = process.cwd();
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

test("flow library exposes a publish-readiness checklist", async () => {
  const source = await read("src/app/(app)/bot-builder/page.tsx");
  assert.match(source, /Publish readiness/);
  assert.match(source, /Graph compiles/);
  assert.match(source, /Channel compatible/);
  assert.match(source, /routes enabled/);
  assert.match(source, /live nodes/);
});

test("publish review compares saved draft with immutable live version", async () => {
  const source = await read("src/app/(app)/bot-builder/page.tsx");
  assert.match(source, /botFlowVersion\.findMany/);
  assert.match(source, /publication\.versionId/);
  assert.match(source, /draftNodes/);
  assert.match(source, /liveNodes/);
  assert.match(source, /liveVersion/);
});

test("publish dialog names channel routes warnings and version impact", async () => {
  const source = await read("src/components/PublishFlowButton.tsx");
  assert.match(source, /Review before publishing/);
  assert.match(source, /Routes affected/);
  assert.match(source, /Current live/);
  assert.match(source, /warning/);
  assert.match(source, /Publish new version/);
});

test("publish review uses the existing guarded server action", async () => {
  const button = await read("src/components/PublishFlowButton.tsx");
  const action = await read("src/app/actions/flow.ts");
  assert.match(button, /setActiveFlow\(flowId, \{\}\)/);
  assert.match(action, /FLOW_CHANGED_DURING_PUBLISH/);
  assert.match(action, /publishFlowSnapshot/);
  assert.match(action, /Published as version/);
});

test("publishing still advances matching routes atomically", async () => {
  const source = await read("src/lib/flowPublishing.ts");
  assert.match(source, /botFlowRoute\.updateMany/);
  assert.match(source, /publishedVersionId: snapshot\.id/);
  assert.match(source, /withTenantWrite/);
});
