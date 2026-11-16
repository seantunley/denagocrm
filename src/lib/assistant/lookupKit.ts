import "server-only";
import { prisma } from "../db";
import { johannesburgDateKey } from "../activityDay";
import { ownedWriteTenantId } from "../tenantWrite";
import { isCustomerSigner } from "../signing/quoteMirror";
import { firstCustomerView, memoCustomer } from "../signing/customerView";
import { type PermissionUser } from "../permissions";

/** What DAX's lookups share (moved from crmAssistant.ts, 2026-11-16 — file-split plan step 2). */

export const DAY = 86_400_000;
/** Candidate cap before in-memory filters (last-contact needs the full set). */
// ponytail: in-memory filter over ≤500 leads; move last-contact into SQL if a workspace outgrows it.
export const CANDIDATES = 500;
export type AssistantRow = { label: string; detail: string; href: string };
export type ToolOutput = { rows: AssistantRow[]; data: unknown[]; truncated: boolean };
export type User = PermissionUser;
export const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
export const dateKey = (d: Date | null | undefined) => (d ? johannesburgDateKey(d) : "never");
export const daysAgo = (d: Date) => Math.floor((Date.now() - d.getTime()) / DAY);
export const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
/** Cancelled activities, in both spellings the data holds. */
export const CANCELLED = ["canceled", "cancelled"];
/**
 * A quote sent from the signing hub keeps its own status "draft" and no
 * viewedAt — sending, opening and signing are recorded on its SignatureRequest
 * and recipients. So "was it sent / has she opened it" reads both.
 */
export type Signing = { status: string; sentAt: Date | null; viewedAt: Date | null; signedAt: Date | null };
export const LIVE_SIGNING = ["sent", "viewed", "in_progress"];

/** Each quote's latest signing request that went out (not a draft, not voided). */
export async function signingFor(quoteIds: string[]): Promise<Map<string, Signing>> {
  if (!quoteIds.length) return new Map();
  const requests = await prisma.signatureRequest.findMany({
    where: { quoteId: { in: quoteIds }, deletedAt: null, status: { notIn: ["draft", "voided"] } },
    orderBy: { createdAt: "desc" },
    select: {
      quoteId: true, status: true, sentAt: true,
      recipients: { select: { role: true, email: true, viewedAt: true, signedAt: true } },
    },
  });
  const isCustomer = memoCustomer((r) => isCustomerSigner(r, ownedWriteTenantId()));
  const byQuote = new Map<string, Signing>();
  for (const r of requests) {
    if (!r.quoteId || byQuote.has(r.quoteId)) continue;
    const signed = r.recipients.map((x) => x.signedAt).filter((d): d is Date => d !== null).map((d) => d.getTime());
    byQuote.set(r.quoteId, {
      status: r.status,
      sentAt: r.sentAt,
      // The CUSTOMER's first open — a staff countersigner opening it isn't her.
      viewedAt: await firstCustomerView(r.recipients, isCustomer),
      signedAt: r.status === "completed" && signed.length ? new Date(Math.max(...signed)) : null,
    });
  }
  return byQuote;
}

/** "Has she opened it?" — a draft never sent is the real answer, not "not yet". */
export const viewedByCustomer = (q: { status: string; viewedAt: Date | null }, s?: Signing) => {
  const opened = q.viewedAt ?? s?.viewedAt ?? null;
  if (opened) return dateKey(opened);
  return q.status === "draft" && !s ? "not sent yet (still a draft)" : "not yet";
};

/** What the quote's status means to a person: a "draft" sent for signature has been sent. */
export const quoteFacts = (q: { status: string; signedAt: Date | null }, s?: Signing) => ({
  status: s && q.status === "draft" ? `sent for signature (${s.status})` : q.status,
  ...(s ? { sentForSignature: dateKey(s.sentAt) } : {}),
  signed: q.signedAt ? dateKey(q.signedAt) : s?.signedAt ? dateKey(s.signedAt) : "no",
});
export function refused(what: string): ToolOutput {
  return { truncated: false, rows: [], data: [{ note: `You don't have access to ${what}.` }] };
}

/** "2026-10-07T14:30" — a moment as South African wall-clock time, the form the actions take. */
export function saLocal(d: Date): string {
  return new Date(d.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
