import assert from "node:assert/strict";
import test from "node:test";
import { sessionStatus, type SessionRow } from "../src/lib/sessionStillValid";

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
const status = (s: SessionRow, a: Parameters<typeof sessionStatus>[1] = account, idle = 60) =>
  sessionStatus(s, a, idle, NOW);
const valid = (s: SessionRow, a?: Parameters<typeof sessionStatus>[1], idle?: number) => status(s, a, idle) === "active";

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

test("a sign-in from before the version was recorded is never counted active, even after a policy save", () => {
  // Account bumped to 9 by a policy save / sign-out-all: we can't tell whether this row's token predates it.
  assert.equal(status(row({ sessionVersion: null }), { sessionVersion: 9, disabledAt: null }), "unverified");
  // The time and account rules still end it outright.
  assert.equal(status(row({ sessionVersion: null, lastActiveAt: minsAgo(71) })), "ended");
  assert.equal(status(row({ sessionVersion: null }), { sessionVersion: 9, disabledAt: minsAgo(1) }), "ended");
});
