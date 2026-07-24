import test from "node:test";
import assert from "node:assert/strict";
import { calculateSurveyMetrics } from "../src/lib/surveyAnalytics";

const sent = new Date("2026-07-01T08:00:00Z");

test("response rate excludes failed and suppressed invites from the denominator", () => {
  const metrics = calculateSurveyMetrics([
    { status: "completed", type: "nps", score: 10, inviteSentAt: sent, sentAt: sent, completedAt: new Date("2026-07-01T10:00:00Z") },
    { status: "sent", type: "nps", score: null, inviteSentAt: sent, sentAt: sent, completedAt: null },
    { status: "failed_permanent", type: "nps", score: null, inviteSentAt: null, sentAt: sent, completedAt: null },
    { status: "suppressed", type: "nps", score: null, inviteSentAt: null, sentAt: sent, completedAt: null },
  ]);
  assert.equal(metrics.delivered, 2);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.responseRate, 50);
});

test("NPS uses promoter minus detractor percentages", () => {
  const metrics = calculateSurveyMetrics([
    { status: "completed", type: "nps", score: 10, inviteSentAt: sent, sentAt: sent, completedAt: sent },
    { status: "completed", type: "nps", score: 9, inviteSentAt: sent, sentAt: sent, completedAt: sent },
    { status: "completed", type: "nps", score: 8, inviteSentAt: sent, sentAt: sent, completedAt: sent },
    { status: "completed", type: "nps", score: 5, inviteSentAt: sent, sentAt: sent, completedAt: sent },
  ]);
  assert.equal(metrics.promoters, 2);
  assert.equal(metrics.passives, 1);
  assert.equal(metrics.detractors, 1);
  assert.equal(metrics.nps, 25);
});

test("CSAT and average response time are calculated from completed eligible responses", () => {
  const metrics = calculateSurveyMetrics([
    { status: "completed", type: "csat", score: 5, inviteSentAt: sent, sentAt: sent, completedAt: new Date("2026-07-01T10:00:00Z") },
    { status: "completed", type: "csat", score: 4, inviteSentAt: sent, sentAt: sent, completedAt: new Date("2026-07-01T12:00:00Z") },
    { status: "completed", type: "csat", score: 2, inviteSentAt: sent, sentAt: sent, completedAt: new Date("2026-07-01T14:00:00Z") },
  ]);
  assert.equal(metrics.csat, 66.7);
  assert.equal(metrics.averageResponseHours, 4);
});
