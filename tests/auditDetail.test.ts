import test from "node:test";
import assert from "node:assert/strict";

import { matchAuditDetail, fieldChanges, type AuditDetailSource } from "../src/lib/auditDetail";

/**
 * Pairing a timeline entry with the detail behind it.
 *
 * The timeline is built from `AuditLog` (action, summary, who). What changed
 * lives in `AuditEvent`. Nothing keys the two together: they are written in one
 * transaction, but `AuditLog.createdAt` comes from Prisma and
 * `AuditEvent.createdAt` from PostgreSQL, so — measured against production —
 * the timestamps are close and never equal.
 *
 * A join like that fails quietly and convincingly: it shows a real set of field
 * changes under the wrong entry, and a plausible wrong answer in an audit
 * trail is worse than no answer. These tests are about not doing that.
 */

const at = (iso: string) => new Date(iso);

const event = (over: Partial<AuditDetailSource>): AuditDetailSource => ({
  eventType: "contact.updated",
  entityId: "c_1",
  createdAt: at("2026-08-07T11:14:49.500Z"),
  changedFieldsJson: ["phone"],
  beforeJson: { phone: "0821111111" },
  afterJson: { phone: "0822222222" },
  ...over,
});

const row = (over: Partial<Parameters<typeof matchAuditDetail>[0][number]> = {}) => ({
  id: "log_1",
  action: "contact.updated",
  contactId: "c_1",
  leadId: null,
  createdAt: at("2026-08-07T11:14:49.263Z"),
  ...over,
});

test("an entry is paired with its own event despite the clock skew", () => {
  // 237ms apart — the real gap measured in production, from two different clocks.
  const detail = matchAuditDetail([row()], [event({})]);
  assert.deepEqual(detail.log_1.changed, [
    { field: "phone", before: "0821111111", after: "0822222222" },
  ]);
});

test("an event for a different subject is never borrowed", () => {
  const detail = matchAuditDetail([row()], [event({ entityId: "c_OTHER" })]);
  assert.equal(detail.log_1, undefined, "detail from another record must not be shown");
});

test("an event for a different action is never borrowed", () => {
  const detail = matchAuditDetail([row()], [event({ eventType: "contact.deleted" })]);
  assert.equal(detail.log_1, undefined);
});

test("an event too far away in time is not the same event", () => {
  const detail = matchAuditDetail([row()], [event({ createdAt: at("2026-08-07T11:15:30.000Z") })]);
  assert.equal(detail.log_1, undefined);
});

test("two edits seconds apart do not both claim the same detail", () => {
  // A double submit produces two audit rows and one event. Showing the same
  // change under both would assert an edit that never happened.
  const first = row({ id: "log_1", createdAt: at("2026-08-07T11:14:49.000Z") });
  const second = row({ id: "log_2", createdAt: at("2026-08-07T11:14:49.400Z") });

  const detail = matchAuditDetail([second, first], [event({ createdAt: at("2026-08-07T11:14:49.100Z") })]);
  const claimed = [detail.log_1, detail.log_2].filter(Boolean);
  assert.equal(claimed.length, 1, "exactly one entry may own the event");
  assert.ok(detail.log_1, "the earlier entry takes it");
});

test("each entry keeps its own event when both are present", () => {
  const first = row({ id: "log_1", createdAt: at("2026-08-07T11:14:49.000Z") });
  const second = row({ id: "log_2", createdAt: at("2026-08-07T11:20:00.000Z") });
  const detail = matchAuditDetail(
    [first, second],
    [
      event({ createdAt: at("2026-08-07T11:14:49.100Z"), afterJson: { phone: "A" } }),
      event({ createdAt: at("2026-08-07T11:20:00.100Z"), afterJson: { phone: "B" } }),
    ],
  );
  assert.equal(detail.log_1.changed[0].after, "A");
  assert.equal(detail.log_2.changed[0].after, "B");
});

test("noise is not presented as a change", () => {
  // Bookkeeping columns and unchanged values both crowd out the one line
  // somebody actually came to read.
  const changes = fieldChanges(
    event({
      changedFieldsJson: ["phone", "updatedAt", "id", "notes"],
      beforeJson: { phone: "081", updatedAt: "2026-01-01", id: "c_1", notes: "same" },
      afterJson: { phone: "082", updatedAt: "2026-02-02", id: "c_1", notes: "same" },
    }),
  );
  assert.deepEqual(changes.map((c) => c.field), ["phone"]);
});

test("secrets are never rendered, even if an audit captured them", () => {
  const changes = fieldChanges(
    event({
      changedFieldsJson: ["totpSecret", "passwordHash", "email"],
      beforeJson: { totpSecret: "OLD", passwordHash: "OLD", email: "a@b.c" },
      afterJson: { totpSecret: "NEW", passwordHash: "NEW", email: "d@e.f" },
    }),
  );
  assert.deepEqual(changes.map((c) => c.field), ["email"]);
});

test("older entries still yield a diff when the field list was never populated", () => {
  // `changedFieldsJson` is empty on entries written before the field list was
  // recorded. The snapshots are there; deriving from them is better than
  // discarding detail we hold.
  const changes = fieldChanges(
    event({
      changedFieldsJson: [],
      beforeJson: { firstName: "Gavin", phone: "081" },
      afterJson: { firstName: "Gavin", phone: "082" },
    }),
  );
  assert.deepEqual(changes, [{ field: "phone", before: "081", after: "082" }]);
});

test("an event with nothing to show reports empty rather than inventing detail", () => {
  const detail = matchAuditDetail(
    [row()],
    [event({ changedFieldsJson: [], beforeJson: null, afterJson: null })],
  );
  assert.deepEqual(detail.log_1.changed, []);
  assert.equal(detail.log_1.empty, true);
});
