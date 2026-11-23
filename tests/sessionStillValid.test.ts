import assert from "node:assert/strict";
import test from "node:test";
import { sessionStillValid, type SessionRow } from "../src/lib/sessionStillValid";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const minsAgo = (m: number) => new Date(NOW - m * 60_000);
const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  platform: "web",
  createdAt: minsAgo(30),
  lastActiveAt: minsAgo(5),
  revokedAt: null,
  sessionVersion: 3,
  ...over,
});
const account = { sessionVersion: 3, disabledAt: null };
const valid = (s: SessionRow, a: Parameters<typeof sessionStillValid>[1] = account, idle = 60) =>
  sessionStillValid(s, a, idle, NOW);

test("a recent, active sign-in is listed", () => {
  assert.equal(valid(row()), true);
});

test("a sign-in made before 'sign everyone out' (e.g. a policy save) is not listed", () => {
  assert.equal(valid(row(), { sessionVersion: 4, disabledAt: null }), false);
});

test("a sign-in that timed out for inactivity is not listed", () => {
  // 60 min idle + 10 min lastActiveAt write slack.
  assert.equal(valid(row({ lastActiveAt: minsAgo(71) })), false);
  assert.equal(valid(row({ lastActiveAt: minsAgo(65) })), true, "inside the 10-minute write slack");
});

test("a refreshed, active sign-in still ends at its fixed 72h lifetime", () => {
  assert.equal(valid(row({ createdAt: minsAgo(71 * 60), lastActiveAt: minsAgo(1) })), true);
  assert.equal(valid(row({ createdAt: minsAgo(73 * 60), lastActiveAt: minsAgo(1) })), false);
});

test("the mobile app gets a 7-day lifetime and a 7-day idle timeout", () => {
  const pwa = (createdH: number, idleH: number) =>
    valid(row({ platform: "pwa", createdAt: minsAgo(createdH * 60), lastActiveAt: minsAgo(idleH * 60) }));
  assert.equal(pwa(6 * 24, 3 * 24), true);
  assert.equal(pwa(8 * 24, 1), false);
});

test("disabled accounts, missing accounts and revoked rows list nothing", () => {
  assert.equal(valid(row(), { sessionVersion: 3, disabledAt: minsAgo(1) }), false);
  assert.equal(valid(row(), null), false);
  assert.equal(valid(row({ revokedAt: minsAgo(1) })), false);
});

test("rows from before the version was recorded fall back to the time rules", () => {
  assert.equal(valid(row({ sessionVersion: null }), { sessionVersion: 9, disabledAt: null }), true);
});
