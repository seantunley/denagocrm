import { prisma } from "./db";
import { logAudit, logAuditStrict } from "./audit";
import { topPosition } from "./leadPos";
import { sendPushToAll, type PushKind } from "./push";
import { emitLeadJourneyEvent } from "./leadJourneyEvents";

/**
 * The ONE place a Lead row is created.
 *
 * Five call sites used to run `prisma.lead.create` themselves — the web form,
 * the website/Lead-Ads intake, inbound WhatsApp, Facebook/Instagram DMs and the
 * chatbot — and each carried its own idea of what "a lead was created" means.
 * Only two of them fired `runLeadAutomations("lead_created")`, so a rule
 * configured as "when a new lead is created → notify me / create a follow-up
 * activity" worked for a web-form lead and did NOTHING for a WhatsApp,
 * Messenger, Instagram or bot lead. Three sent no push, so an inbound WhatsApp
 * lead arrived silently. Two never set `position`, so those leads sorted below
 * every other card in the first pipeline column. One wrote no audit entry at all.
 *
 * Everything a new lead owes the workspace lives here: stage + position
 * resolution, the audit entry, the push and the `lead_created` automation
 * trigger. What legitimately differs per source — the title, the channel
 * metadata, the contact linkage, the audit wording, which push (if any) — comes
 * in as parameters.
 *
 * All of this runs on `prisma`, the SCOPED client, exactly as all five call
 * sites did: a lead is tenant-owned data and must be stamped and RLS-scoped like
 * any other. `basePrisma` appears in these flows only for the `externalId`
 * dedupe lookup, which deliberately has to see soft-deleted rows — that is a
 * read, and it stays where it is.
 */

/** The row itself. Everything a source may legitimately vary. */
export type NewLeadFields = {
  title: string;
  name: string;
  source: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  color?: string | null;
  productId?: string | null;
  contactId?: string | null;
  assignedToId?: string | null;
  createdById?: string | null;
  quantity?: number;
  valueCents?: number;
  externalId?: string | null;
  /** Raw intake payload; stored as a JSON string. */
  raw?: unknown;
  /**
   * The stage to open the lead in. Omitted (every inbound channel) → the first
   * stage by `order`, which is what those channels each looked up for
   * themselves. The form path passes a stage it has ALREADY validated as open
   * and must keep doing so — resolving one here would silently move a lead the
   * user deliberately placed.
   */
  stageId?: string | null;
};

/**
 * The trail entry. Every source writes one; they differ in wording, in actor and
 * in whether a failure to write it is fatal.
 */
export type LeadAudit = {
  action: string;
  summary: string;
  /**
   * Treat an unwritable audit trail as a failed create (logAuditStrict throws).
   * The staff-facing form does; a webhook does not — there, a failed audit must
   * not cost us the lead the customer just sent.
   */
  strict?: boolean;
  user?: { id: string; name: string } | null;
  userName?: string;
  /** Record the created row as the audit event's `after` payload. */
  recordAfter?: boolean;
};

/** A push announcing the new lead. The URL is always the lead itself. */
export type LeadPush = { title: string; body: string; kind: PushKind };

export type NewLead = NewLeadFields & {
  audit: LeadAudit;
  /**
   * Omitted → the standard "New lead" push on the `lead_new` toggle, which is
   * what the intake path already sent and what the inbound channels were
   * missing. `null` → none. A source with its own better-worded notification
   * (the bot's demo request) passes that instead, so the customer is announced
   * once, not twice.
   */
  push?: LeadPush | null;
};

/** The first stage of the pipeline, as every inbound channel resolved it. */
async function resolveStageId(stageId?: string | null): Promise<string | null> {
  if (stageId) return stageId;
  const firstStage = await prisma.pipelineStage.findFirst({ orderBy: { order: "asc" } });
  return firstStage?.id ?? null;
}

async function createInStage(input: NewLead, stageId: string) {
  // Read BEFORE the transaction so the write holds its locks for as little time
  // as possible.
  const position = await topPosition(stageId);

  const data = {
    title: input.title,
    name: input.name,
    source: input.source,
    email: input.email ?? null,
    phone: input.phone ?? null,
    notes: input.notes ?? null,
    color: input.color ?? null,
    productId: input.productId ?? null,
    contactId: input.contactId ?? null,
    assignedToId: input.assignedToId ?? null,
    createdById: input.createdById ?? null,
    // Omitted quantity keeps the schema default of 1 rather than forcing a 0.
    ...(input.quantity != null ? { quantity: input.quantity } : {}),
    valueCents: input.valueCents ?? 0,
    externalId: input.externalId ?? null,
    raw: input.raw != null ? JSON.stringify(input.raw) : null,
    stageId,
    // Top of the column, for every source. The DM and bot paths left this at
    // the default 0 while topPosition hands out DECREASING numbers, so an ad
    // or bot lead landed underneath every lead that came through the form.
    position,
  };

  const auditFor = (lead: { id: string; contactId: string | null }) => ({
    action: input.audit.action,
    summary: input.audit.summary,
    leadId: lead.id,
    contactId: lead.contactId,
    user: input.audit.user ?? null,
    userName: input.audit.userName,
    ...(input.audit.recordAfter ? { after: lead } : {}),
  });

  /**
   * A STRICT audit and the row it describes commit together, or neither does.
   *
   * Writing the lead first and auditing afterwards is what turned an audit
   * failure into duplicate records in production on 2026-08-07: the lead was
   * already committed, `logAuditStrict` threw, the operator was told the save
   * failed, and the retry created a second lead. Fixing the particular cause of
   * that failure is not enough — ANY audit failure produces the same outcome,
   * because "governance write, then governance record" is two commits.
   *
   * Inside one transaction there is no such window. A failed audit rolls the
   * lead back, so the error the operator sees is true and the retry is safe.
   *
   * Only the STRICT path joins the transaction. A best-effort audit deliberately
   * swallows its error, and swallowing an error inside a transaction is worse
   * than useless — PostgreSQL has already aborted it, so every later statement
   * fails and the commit dies anyway, taking a lead nobody wanted to lose. A
   * best-effort audit therefore stays outside, exactly as before.
   */
  const lead = input.audit.strict
    ? await prisma.$transaction(async (tx) => {
        const created = await tx.lead.create({ data });
        await logAuditStrict(auditFor(created), tx);
        return created;
      })
    : await prisma.lead.create({ data });

  if (!input.audit.strict) await logAudit(auditFor(lead));

  const push =
    input.push === undefined
      ? {
          title: "New lead 🚀",
          body: `${lead.title} — ${lead.name} (via ${lead.source})`,
          kind: "lead_new" as const,
        }
      : input.push;
  if (push) {
    // Best-effort, as at every existing call site: a push service that is down
    // must not fail the create — nor 500 the webhook that is delivering it.
    await sendPushToAll(
      { title: push.title, body: push.body, url: `/leads/${lead.id}` },
      push.kind,
    ).catch(() => {});
  }

  // Last, and safe to await bare: emitLeadJourneyEvent resolves rather than
  // rejects — it inherited that contract from runLeadAutomations, whose whole
  // body was wrapped in "Automations must never break the main flow". Three of
  // the five callers below are inbound webhooks (WhatsApp, Messenger, the bot),
  // and a broken journey must not turn an accepted lead into a 500 that makes
  // the provider retry.
  //
  // `source` rides along in the payload so a journey can branch on where the
  // lead came from without re-reading the row.
  await emitLeadJourneyEvent("lead_created", lead.id, { payload: { source: lead.source } });
  return lead;
}

/**
 * Creates a lead and runs everything a new lead owes the workspace.
 *
 * Throws when no pipeline stage exists. Callers with a person in front of them
 * (the form, the intake API) should surface that rather than silently swallow
 * the lead.
 */
export async function createLeadRecord(input: NewLead) {
  const stageId = await resolveStageId(input.stageId);
  if (!stageId) throw new Error("No pipeline stages configured");
  return createInStage(input, stageId);
}

/**
 * The inbound-channel variant: returns null instead of throwing when the
 * workspace has no pipeline stage configured.
 *
 * This is the `if (firstStage)` guard the WhatsApp, DM and bot handlers each
 * carried, kept intact. Those handlers do more work after the lead — the
 * inbound message row, the bot's reply — and their webhooks wrap the whole call
 * in a catch, so throwing here would cost us the customer's MESSAGE as well as
 * the lead.
 */
export async function createLeadRecordIfPipelineReady(input: NewLead) {
  const stageId = await resolveStageId(input.stageId);
  if (!stageId) return null;
  return createInStage(input, stageId);
}
