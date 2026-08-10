import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const migration = () => src("prisma/migrations/20260809161000_bot_flow_session_analytics_trigger/migration.sql");

test("all stateful chatbot channels are instrumented at the shared BotSession boundary", () => {
  const sql = migration();
  assert.match(sql, /CREATE TRIGGER "BotSession_flow_analytics"/);
  assert.match(sql, /AFTER INSERT OR UPDATE OR DELETE ON "BotSession"/);
  assert.match(sql, /NEW\."channel"/);
  assert.match(sql, /NEW\."key"/);
});

test("both WhatsApp and shared-runner flow version encodings are understood", () => {
  const sql = migration();
  assert.match(sql, /->> '__flow_version'/);
  assert.match(sql, /->> 'fv'/);
});

test("manual takeover is not counted as a bot handoff", () => {
  const sql = migration();
  const handoffAt = sql.indexOf("Bot handoff writes paused + NULL nodeId");
  const handoff = sql.slice(handoffAt, sql.indexOf("RETURN NEW", handoffAt));
  assert.match(handoff, /NEW\."status" = 'paused'/);
  assert.match(handoff, /NEW\."nodeId" IS NULL/);
  assert.match(handoff, /'flow_handoff'/);
  assert.match(sql, /Manual takeover preserves the current nodeId/);
});

test("expired sessions and Return-to-bot deletes cannot masquerade as completions", () => {
  const sql = migration();
  const completeAt = sql.indexOf("Normal flow completion deletes an ACTIVE");
  const complete = sql.slice(completeAt);
  assert.match(complete, /OLD\."status" = 'active'/);
  assert.match(complete, /OLD\."expiresAt" >= CURRENT_TIMESTAMP/);
  assert.match(complete, /old_version_id IS NOT NULL/);
  assert.match(complete, /'flow_completed'/);
});

test("interaction type comes from the immutable published node definition", () => {
  const sql = migration();
  assert.match(sql, /FROM "BotFlowVersion"/);
  assert.match(sql, /"definition"::jsonb -> 'nodes' -> OLD\."nodeId" ->> 'type'/);
  assert.match(sql, /WHEN 'choice' THEN 'choice_selected'/);
  assert.match(sql, /WHEN 'capture' THEN 'capture_submitted'/);
  assert.match(sql, /WHEN 'captureFile' THEN 'capture_submitted'/);
  assert.match(sql, /WHEN 'slots' THEN 'slot_selected'/);
});

test("manual paused-row insertion without a flow version is not a fake flow start", () => {
  const sql = migration();
  assert.match(sql, /NEW\."status" = 'paused' AND NEW\."nodeId" IS NULL AND version_id IS NOT NULL/);
  assert.match(sql, /Manual takeover can[\s\S]+INSERT a paused row[\s\S]+no flow version/);
});
