import "server-only";
import { prisma } from "./db";
import { deliveryFailureReason } from "./messageDelivery";

export type QueueFailure = { id: string; at: Date; detail: string; href: string | null };
export type QueueSummary = {
  key: string;
  label: string;
  description: string;
  /** Rows created in the window, by status. */
  counts: Array<{ status: string; count: number }>;
  /** Due work that should have run by now and hasn't — the "is the worker alive?" number. */
  stuck: number;
  failures: QueueFailure[];
};

const WINDOW_DAYS = 7;
const STUCK_AFTER_MS = 15 * 60 * 1000;
const FAILURES_SHOWN = 10;
const clip = (text: string | null | undefined, max = 160) => (text ? (text.length > max ? `${text.slice(0, max)}…` : text) : "");

function tally(groups: Array<{ status: string; _count: { _all: number } }>) {
  return groups.map((g) => ({ status: g.status, count: g._count._all })).sort((a, b) => b.count - a.count);
}

/**
 * Every background queue's state on one screen (gap audit #34). Their failures
 * used to surface only in the 30-day error log, so a worker that stopped, or a
 * queue quietly dead-lettering, went unnoticed until a customer said so.
 *
 * Guarded client throughout: every count and row is the viewer's workspace.
 */
export async function loadQueueHealth(): Promise<QueueSummary[]> {
  const now = Date.now();
  const since = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const overdue = new Date(now - STUCK_AFTER_MS);

  const [signing, outbox, campaigns, surveys, journeys] = await Promise.all([
    // ── Signing jobs (dispatch, reminders, post-signature steps) ──
    Promise.all([
      prisma.signingJob.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.signingJob.count({ where: { status: { in: ["pending", "retry"] }, availableAt: { lt: overdue } } }),
      prisma.signingJob.findMany({
        where: { status: "dead" },
        orderBy: { updatedAt: "desc" },
        take: FAILURES_SHOWN,
        select: { id: true, jobType: true, lastError: true, requestId: true, updatedAt: true },
      }),
    ]),
    // ── Bot / staff message outbox ──
    Promise.all([
      prisma.botFlowOutbox.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.botFlowOutbox.count({ where: { status: { in: ["pending", "retry"] }, availableAt: { lt: overdue } } }),
      prisma.botFlowOutbox.findMany({
        // The failure itself, not the backlog it took down with it.
        where: { status: "dead", NOT: { failureCode: "blocked_by_earlier_failure" } },
        orderBy: { updatedAt: "desc" },
        take: FAILURES_SHOWN,
        select: { id: true, channel: true, origin: true, failureCode: true, updatedAt: true },
      }),
    ]),
    // ── Campaign sends (no createdAt: the window is attempts, plus anything still pending) ──
    Promise.all([
      prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { OR: [{ lastAttemptAt: { gte: since } }, { sentAt: { gte: since } }, { status: { in: ["pending", "queued", "sending"] } }] },
        _count: { _all: true },
      }),
      prisma.campaignRecipient.count({
        where: { OR: [{ status: { in: ["queued", "failed_temporary"] }, nextAttemptAt: { lt: overdue } }, { status: "sending", lastAttemptAt: { lt: overdue } }] },
      }),
      prisma.campaignRecipient.findMany({
        where: { status: "failed_permanent" },
        orderBy: { lastAttemptAt: "desc" },
        take: FAILURES_SHOWN,
        select: { id: true, campaignId: true, error: true, lastAttemptAt: true, sentAt: true, campaign: { select: { name: true } } },
      }),
    ]),
    // ── Survey invitations sent by distributions (sentAt defaults to the row's creation) ──
    Promise.all([
      prisma.surveyResponse.groupBy({ by: ["status"], where: { distributionId: { not: null }, sentAt: { gte: since } }, _count: { _all: true } }),
      prisma.surveyResponse.count({ where: { distributionId: { not: null }, status: { in: ["queued", "failed_temporary"] }, nextAttemptAt: { lt: overdue } } }),
      prisma.surveyResponse.findMany({
        where: { distributionId: { not: null }, status: { in: ["failed", "failed_permanent"] } },
        orderBy: { sentAt: "desc" },
        take: FAILURES_SHOWN,
        select: { id: true, distributionId: true, providerStatus: true, sentAt: true, lastAttemptAt: true },
      }),
    ]),
    // ── Journey runs ──
    Promise.all([
      prisma.journeyRun.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.journeyRun.count({ where: { status: "queued", nextRunAt: { lt: overdue } } }),
      prisma.journeyRun.findMany({
        where: { status: { in: ["failed", "blocked"] } },
        orderBy: { updatedAt: "desc" },
        take: FAILURES_SHOWN,
        select: { id: true, status: true, lastError: true, updatedAt: true, journey: { select: { name: true } } },
      }),
    ]),
  ]);

  return [
    {
      key: "signing",
      label: "Signing jobs",
      description: "Sending documents for signature, reminders and the steps after signing.",
      counts: tally(signing[0]),
      stuck: signing[1],
      failures: signing[2].map((job) => ({
        id: job.id,
        at: job.updatedAt,
        detail: `${job.jobType.replaceAll("_", " ")}: ${clip(job.lastError) || "failed"}`,
        href: `/signatures/${job.requestId}`,
      })),
    },
    {
      key: "outbox",
      label: "Customer messages (bot & inbox)",
      description: "WhatsApp, Messenger, Instagram and Telegram messages from the bot and from staff.",
      counts: tally(outbox[0]),
      stuck: outbox[1],
      failures: outbox[2].map((row) => ({
        id: row.id,
        at: row.updatedAt,
        // The classified reason only — the raw provider text can quote a number.
        detail: `${row.origin === "staff" ? "Staff reply" : "Bot message"} on ${row.channel}: ${deliveryFailureReason(row.failureCode) ?? "the channel rejected it"}`,
        href: "/inbox",
      })),
    },
    {
      key: "campaigns",
      label: "Campaign sends",
      description: "One row per recipient of each marketing campaign.",
      counts: tally(campaigns[0]),
      stuck: campaigns[1],
      failures: campaigns[2].map((row) => ({
        id: row.id,
        at: row.lastAttemptAt ?? row.sentAt ?? new Date(now),
        detail: `${row.campaign.name}: ${clip(row.error) || "could not be delivered"}`,
        href: `/marketing/campaigns/${row.campaignId}`,
      })),
    },
    {
      key: "surveys",
      label: "Survey invitations",
      description: "Invitations sent by survey distributions.",
      counts: tally(surveys[0]),
      stuck: surveys[1],
      failures: surveys[2].map((row) => ({
        id: row.id,
        at: row.lastAttemptAt ?? row.sentAt,
        detail: clip(row.providerStatus) || "could not be delivered",
        href: row.distributionId ? `/marketing/surveys/distributions/${row.distributionId}` : null,
      })),
    },
    {
      key: "journeys",
      label: "Journey runs",
      description: "Each person moving through an automation journey.",
      counts: tally(journeys[0]),
      stuck: journeys[1],
      failures: journeys[2].map((run) => ({
        id: run.id,
        at: run.updatedAt,
        detail: `${run.journey.name} (${run.status}): ${clip(run.lastError) || "stopped"}`,
        href: "/journeys/activity",
      })),
    },
  ];
}
