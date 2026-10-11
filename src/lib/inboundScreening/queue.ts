import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { restoreLeaseCutoff } from "./review";

export const REVIEW_PAGE_SIZE = 50;
export const REVIEW_VIEWS = {
  pending: "Needs review",
  confirmed: "Confirmed spam",
  observe: "Observe — would have held",
  missed: "Missed spam",
  restored: "Restored",
} as const;
export type ReviewView = keyof typeof REVIEW_VIEWS;
export type ReviewParams = Record<string, string | string[] | undefined>;
export function reviewFilters(params: ReviewParams) {
  const one = (key: string) => typeof params[key] === "string" ? params[key] as string : "";
  const view = one("spamView");
  const page = Number(one("spamPage"));
  const channel = one("spamChannel");
  const cause = one("spamCause");
  const review = one("spamReview");
  return {
    view: (Object.hasOwn(REVIEW_VIEWS, view) ? view : "pending") as ReviewView,
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1000000) : 1,
    review: ["unreviewed", "spam", "not_spam"].includes(review) ? review : "",
    search: one("spamSearch").trim().slice(0, 120),
    channel: ["whatsapp", "messenger", "instagram"].includes(channel) ? channel : "",
    cause: cause === "blocked" || cause === "filter" ? cause : "",
  };
}
export type ReviewFilters = ReturnType<typeof reviewFilters>;

/** Filtering happens BEFORE pagination; every page remains scoped to the workspace. */
export function reviewWhere(tenantId: string, filters: ReviewFilters): Prisma.InboundScreeningWhereInput {
  const held = { OR: [{ state: "quarantined" }, { state: "restoring", updatedAt: { lt: restoreLeaseCutoff() } }] };
  const views: Record<ReviewView, Prisma.InboundScreeningWhereInput> = {
    pending: { AND: [held, { OR: [{ staffLabel: null }, { staffLabel: { not: "spam" } }] }] },
    confirmed: { ...held, staffLabel: "spam" },
    observe: { mode: "observe", state: "admitted", suppressed: { not: Prisma.DbNull } },
    missed: { state: "admitted", staffLabel: "spam" },
    restored: { state: "restored" },
  };
  const and: Prisma.InboundScreeningWhereInput[] = [views[filters.view]];
  if (filters.review) and.push({ staffLabel: filters.review === "unreviewed" ? null : filters.review });
  if (filters.search) and.push({ OR: ["body", "senderId", "senderName"].map((field) => ({ [field]: { contains: filters.search, mode: "insensitive" } })) });
  if (filters.cause) and.push({ decidedBy: filters.cause === "blocked" ? "sender_block" : { not: "sender_block" } });
  return { tenantId, ...(filters.channel ? { channel: filters.channel } : {}), AND: and };
}

export async function reviewMessages(tenantId: string, filters: ReviewFilters) {
  const where = reviewWhere(tenantId, filters);
  const total = await prisma.inboundScreening.count({ where });
  const pages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const rows = await prisma.inboundScreening.findMany({
    where, orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: REVIEW_PAGE_SIZE, skip: (page - 1) * REVIEW_PAGE_SIZE,
    select: { id: true, channel: true, senderId: true, senderName: true, receivedAt: true, body: true, reason: true, reasonCodes: true, decidedBy: true, staffLabel: true, classification: true, state: true, mode: true },
  });
  return { rows, total, page, pages };
}

export function reviewPageHref(filters: ReviewFilters, page: number): string {
  return `/inbox?${new URLSearchParams({ tab: "spam", spamView: filters.view, spamSearch: filters.search, spamChannel: filters.channel, spamCause: filters.cause, spamReview: filters.review, spamPage: String(page) })}`;
}
