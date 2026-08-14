"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { contactName, parseRands } from "@/lib/format";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { recordReferral, markReferralEarned } from "@/lib/referrals";
import { logAudit, logAuditStrict, GOVERNANCE_TX } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { createLeadRecord } from "@/lib/leadCreate";
import { triggerSurvey } from "@/lib/surveys";
import { removeTimelinePin } from "@/lib/timelinePins";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
// `resolveAssignableUser` is the consolidated contract from #460/#467 — it
// supersedes the direct `resolveTenantMemberUser` call this branch was written
// against, and it is the one that enforces membership while dormant.
import { resolveAssignableUser } from "@/lib/tenantActor";
import { withActingStaffScope } from "@/lib/actingScope";
import {
  getAccessibleContactIds,
  hasPermission,
  requireAnyPermission,
  requireLeadAccess,
  requireLeadReadAccess,
  requirePermission,
} from "@/lib/permissions";
import { type PipelineStageAction } from "@/lib/pipelineStageActions";
import {
  getDefaultPipeline,
  getLeadPipeline,
  getPipelineStage,
  listPipelineStages,
  type PipelineStageRow,
} from "@/lib/pipelines";
import {
  CLEAR_VERDICT,
  MIN_OVERRIDE_REASON,
  describeUnmet,
  evaluateStageMove,
  parseStageCriteria,
  parseStageGateMode,
  refusalSentence,
  type StageMoveInput,
  type StageCriteriaGroup,
  type StageGate,
  type StageGateVerdict,
} from "@/lib/stageGate";
import { stageGateFactsForLead } from "@/lib/stageGateFacts";
import {
  DERIVED_GATE_MODE,
  STAGE_REMEDIES,
  derivedCriteria,
  factsAfterRemedy,
  factsIfRemedyIdeal,
  remedyAddresses,
  remedyFor,
  type StageRemedy,
} from "@/lib/stageRemedies";

function leadData(formData: FormData) {
  const str = (key: string) => {
    const value = String(formData.get(key) ?? "").trim();
    return value === "" ? null : value;
  };
  return {
    name: String(formData.get("name") ?? "").trim(),
    email: str("email"),
    phone: str("phone"),
    source: str("source") ?? "manual",
    productId: str("productId"),
    color: str("color"),
    notes: str("notes"),
    quantity: Math.max(1, parseInt(String(formData.get("quantity") ?? "1"), 10) || 1),
    valueCents: parseRands(str("value")),
    stageId: String(formData.get("stageId") ?? ""),
    contactId: str("contactId"),
    assignedToId: str("assignedToId"),
  };
}

/**
 * The word this file uses for an assignee when refusing one. `resolveAssignableUser`
 * builds the sentence from it, so "team member" here is the same noun the pipeline
 * already uses in its own copy ("That team member is no longer available.").
 */
const ASSIGNEE_LABEL = "team member";

async function nextPosition(stageId: string) {
  const max = await prisma.lead.aggregate({
    where: { stageId },
    _max: { position: true },
  });
  return (max._max.position ?? 0) + 1;
}

/**
 * Resolve the posted assignee through tenant membership and hand back the id
 * that may actually be written.
 *
 * The check used to live in `buildTitle`, of all places, as this file's own
 * private copy of the membership rule — a fourth implementation of something
 * that now has one home. Two things changed with it. The rule is the shared
 * contract, so it cannot drift away from the other three; and the caller writes
 * what came BACK rather than what was posted, so the unvalidated value has no
 * route into the update at all. It also no longer hides inside a function whose
 * job is to name the lead.
 */
async function resolveLeadAssignee(assignedToId: string | null): Promise<string | null> {
  const assignee = await resolveAssignableUser(assignedToId, ASSIGNEE_LABEL);
  return assignee?.id ?? null;
}

async function buildTitle(data: {
  name: string;
  productId: string | null;
  color: string | null;
  contactId?: string | null;
}) {
  if (data.contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: data.contactId },
      select: { id: true },
    });
    if (!contact) throw new Error("That contact is not available in this workspace");
  }
  if (!data.productId) return data.name;
  const product = await prisma.product.findUnique({
    where: { id: data.productId },
    select: { name: true },
  });
  if (!product) throw new Error("That product is not available in this workspace");
  return [product.name, data.color].filter(Boolean).join(" – ");
}

async function defaultOpenStageId() {
  const pipeline = await getDefaultPipeline();
  if (!pipeline) throw new Error("No active sales pipeline configured");
  const stages = await listPipelineStages(pipeline.id);
  const stage = stages.find((item) => !item.isClosed);
  if (!stage) throw new Error("The default pipeline has no open stage");
  return stage.id;
}

/**
 * The stage a move is targeting, or the REASON it cannot be — as a value.
 *
 * Next's guidance for Server Functions is explicit: "avoid using try/catch blocks
 * and throw errors. Instead, model expected errors as return values."
 * (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md,
 * "Handling expected errors"). A stage that has been deleted, or one that is
 * closed, is an expected outcome of dragging a card on a board somebody else may
 * have reconfigured — not an exception.
 *
 * The throwing wrapper below stays for the actions that run inside
 * `asActionResult`, which turns a refusal back into a value at the boundary.
 */
async function resolveOpenStage(stageId: string): Promise<{ stage: PipelineStageRow } | { error: string }> {
  const stage = await getPipelineStage(stageId);
  if (!stage) return { error: "Selected pipeline stage does not exist" };
  if (stage.isClosed) {
    return { error: "Use Mark won or Mark lost instead of creating or dragging into a closed stage" };
  }
  return { stage };
}

async function validateOpenStage(stageId: string) {
  const resolved = await resolveOpenStage(stageId);
  // ActionRefusal, not a bare Error: both messages are written to be READ, and
  // `classifyFailure` shows a refusal verbatim while a bare Error is replaced
  // with the generic "did not complete cleanly" line. saveLead already raises the
  // identical pipeline-permission message this way.
  if ("error" in resolved) throw new ActionRefusal(resolved.error);
  return resolved.stage;
}

export async function createLead(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("leads.create");
    const data = leadData(formData);
    if (!data.name) throw new ActionRefusal("Name is required");
    if (!data.stageId) data.stageId = await defaultOpenStageId();
    await validateOpenStage(data.stageId);

    if (!data.assignedToId) data.assignedToId = user.id;
    if (data.assignedToId !== user.id && !(await hasPermission(user, "leads.assign"))) {
      throw new ActionRefusal("You do not have permission to assign leads to another user");
    }
    // Permission first (may this caller assign to somebody else at all), then
    // membership (is that somebody a member of THIS workspace) — the same order
    // the file already used, now answered by the shared contract.
    data.assignedToId = await resolveLeadAssignee(data.assignedToId);

    let contactTookNotesFromNewLead = false;
    const generatedTitle = await buildTitle(data);
    const title = String(formData.get("title") ?? "").trim() || generatedTitle;

    if (!data.contactId) {
      const matchers = [
        ...(data.email ? [{ email: data.email }] : []),
        ...(data.phone ? [{ phone: data.phone }] : []),
      ];
      const existing = matchers.length > 0
        ? await prisma.contact.findFirst({ where: { OR: matchers } })
        : null;
      // Reuse whatever the lookup found.
      //
      // This used to reuse ONLY a contact whose tenantId was null — a workaround
      // for the composite AuditLog foreign key, since auditing against a
      // stamped contact under a mismatched tenant failed. The comment said "or
      // whose tenantId already matches" but the code never checked that, so
      // every one of the existing (backfilled, stamped) contacts was skipped:
      // creating a lead for a customer already on file silently made a SECOND
      // contact for them.
      //
      // The audit now takes its tenant from the record it describes, so the
      // mismatch cannot arise and the workaround is not needed. Cross-tenant
      // reuse is not a risk here either: the lookup runs on the scoped client,
      // which under enforcement cannot see another tenant's contacts.
      if (existing) {
        data.contactId = existing.id;
      } else {
        const [firstName, ...rest] = data.name.split(/\s+/);
        const contact = await prisma.contact.create({
          data: {
            firstName: firstName || data.name,
            lastName: rest.join(" ") || null,
            email: data.email,
            phone: data.phone,
            source: data.source,
            // Whatever was typed in the lead's notes follows the customer onto
            // their contact record. Omitting it dropped it silently: the note was
            // captured on a form the person filled in, and then existed nowhere.
            notes: data.notes,
            createdById: user.id,
            ownerId: data.assignedToId ?? user.id,
          },
        });
        data.contactId = contact.id;
        // The lead does not exist yet — its id is stamped onto the contact once
        // createLeadRecord returns, below. Tracked in a local rather than
        // re-derived later, so the two cannot disagree about whether a note was
        // actually copied.
        contactTookNotesFromNewLead = Boolean(data.notes?.trim());
        await logAudit({
          action: "contact.created",
          summary: `Created contact ${data.name} (with new lead)`,
          contactId: contact.id,
          user,
          after: { firstName: contact.firstName, lastName: contact.lastName, email: contact.email, phone: contact.phone },
        });
      }
    }

    // Through the one lead creator (src/lib/leadCreate.ts) — the row, the audit
    // entry and the `lead_created` automations. This path was the COMPLETE one;
    // the inbound channels each had their own partial copy of it, which is how a
    // WhatsApp/DM/bot lead came to run no automations at all.
    const lead = await createLeadRecord({
      ...data,
      title,
      createdById: user.id,
      audit: {
        action: "lead.created",
        summary: `Created lead “${title}”`,
        // Governance path: an unwritable trail fails the create here, unlike the
        // best-effort audit an inbound webhook gets.
        strict: true,
        recordAfter: true,
        user,
      },
      // No push. The only person a "New lead" notification could tell is the one
      // who just typed it in; the inbound channels get it because nobody is
      // watching the door.
      push: null,
    });

    // Now the lead has an id, record that the contact's note came from it. Not a
    // second source of truth: the timeline reads THIS, and never compares text.
    if (contactTookNotesFromNewLead && data.contactId) {
      await prisma.contact.update({
        where: { id: data.contactId },
        data: { notesFromLeadId: lead.id },
      });
    }
    const refCode = String(formData.get("referralCode") ?? "").trim();
    if (refCode) await recordReferral(refCode, lead.id).catch(() => {});
    revalidatePath("/leads");
    revalidatePath("/forecast");
    return { redirectTo: `/leads/${lead.id}` };
  });
}

export async function updateLead(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(id, "leads.edit");
    const data = leadData(formData);
    if (!data.name) throw new ActionRefusal("Name is required");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id } });
    // `getLeadPipeline` is now bounded by the acting workspace, so null means "not
    // this workspace's lead" as well as "no such lead". It must REFUSE rather than
    // fall through: the check it feeds is `!(await hasPermission(…, "leads.change_pipeline"))`,
    // and a null that skipped it would turn scoping the read into a way past the
    // permission. `moveLeadToTestDrive` already refused; these two now match it.
    const beforePipeline = await getLeadPipeline(id);
    if (!beforePipeline) throw new ActionRefusal("Lead not found");
    const targetStage = await validateOpenStage(data.stageId);

    if (before.assignedToId !== data.assignedToId && !(await hasPermission(user, "leads.assign"))) {
      throw new ActionRefusal("You do not have permission to reassign this lead");
    }
    // An edit is the easier of the two attacks: the lead already exists, so a
    // single forged field on an otherwise ordinary save was all it took. The
    // spread below writes `data`, so the resolved id has to land back on it.
    data.assignedToId = await resolveLeadAssignee(data.assignedToId);
    if (before.stageId !== data.stageId) {
      if (!(await hasPermission(user, "leads.change_stage"))) {
        throw new ActionRefusal("You do not have permission to change the lead stage");
      }
      if (beforePipeline.pipelineId !== targetStage.pipelineId && !(await hasPermission(user, "leads.change_pipeline"))) {
        throw new ActionRefusal("You do not have permission to move leads between pipelines");
      }
    }

    // THE SAME RULES ON THE OTHER DOOR.
    //
    // The lead edit form carries a stage picker, so a rule enforced only in
    // `moveLead` would be walked around by opening the lead and choosing the
    // stage from a dropdown. A gate that the product itself offers a way past is
    // not a gate.
    //
    // No override path here, deliberately: an override has to be RECORDED with a
    // reason, and this form has nowhere to type one. Somebody entitled to
    // override is told where the door with a lock on it is, rather than being
    // handed a quiet one. `warn` still passes, and its unmet clauses ride into
    // the audit below.
    let stageGateVerdict = CLEAR_VERDICT;
    if (before.stageId !== data.stageId) {
      const gated = await gateStageMove({
        leadId: id,
        user,
        currentScope: beforePipeline,
        targetStage,
      });
      if ("error" in gated) throw new ActionRefusal(gated.error);
      stageGateVerdict = gated.verdict;
      if (!stageGateVerdict.allowed) {
        throw new ActionRefusal(refusalSentence(stageGateVerdict, targetStage.name));
      }
      if (stageGateVerdict.requiresReason) {
        throw new ActionRefusal(
          `${refusalSentence(stageGateVerdict, targetStage.name)} Move it on the pipeline board to record a reason.`,
        );
      }
    }

    const generatedTitle = await buildTitle(data);
    const title = String(formData.get("title") ?? "").trim() || generatedTitle;

    if (data.contactId && data.contactId !== before.contactId && before.tenantId) {
      const targetContact = await prisma.contact.findUnique({
        where: { id: data.contactId },
        select: { tenantId: true },
      });
      if (targetContact?.tenantId === null) {
        await prisma.contact.update({
          where: { id: data.contactId },
          data: { tenantId: before.tenantId },
        });
      }
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: { ...data, title, ...(before.stageId !== data.stageId ? { stageEnteredAt: new Date() } : {}) },
    });
    await logAuditStrict({
      action: "lead.updated",
      summary: `Updated lead “${lead.title}”`,
      leadId: id,
      contactId: lead.contactId,
      user,
      before,
      after: lead,
      // A `warn` gate let this through and named what was missing. Recorded on
      // the same terms as the board's own move, so "which deals moved without
      // meeting the rule" is one question with one answer, whichever screen the
      // move came from.
      ...(stageGateVerdict.unmet.length > 0
        ? {
            metadata: {
              gateDirection: stageGateVerdict.direction,
              gateMode: stageGateVerdict.mode,
              gateUnmet: stageGateVerdict.unmet.map(describeUnmet),
            },
          }
        : {}),
    });
    if (before.stageId !== data.stageId) await emitLeadJourneyEvent("stage_entered", id);
    revalidatePath("/leads");
    revalidatePath("/forecast");
    revalidatePath(`/leads/${id}`);
    return { redirectTo: `/leads/${id}` };
  });
}

/**
 * Read one direction's gate off a stage row.
 *
 * The criteria column is JSONB and this is a raw SELECT, so what comes back is
 * whatever is stored — hence the parse. A stored document that no longer parses
 * is treated as a BROKEN gate rather than an absent one: silently ignoring it
 * would turn a rule someone believes is blocking into a rule that does nothing,
 * which is the worst of the three possible outcomes.
 */
function stageGateFor(row: PipelineStageRow, direction: "entry" | "exit"): StageGate | "broken" {
  const mode = parseStageGateMode(direction === "entry" ? row.entryGateMode : row.exitGateMode);
  let criteria: StageCriteriaGroup | null;
  try {
    criteria = parseStageCriteria(direction === "entry" ? row.entryCriteria : row.exitCriteria);
  } catch {
    // An `off` gate cannot block anything, so an unreadable one is not worth
    // stopping a board over — it is only reported when it would have mattered.
    return mode === "off" ? { mode: "off", criteria: null } : "broken";
  }

  // THE DERIVATION THAT MAKES THIS SHIP WITHOUT A BACKFILL.
  //
  // A stage that declares a REMEDY and stores no entry rule of its own is judged
  // by exactly what that remedy provides, at `block`. So `book_test_drive`
  // behaves as it always has — the booking is mandatory — while becoming the
  // derived case of the general mechanism rather than a special case beside it.
  //
  // One thing does change, and it is the point: the criterion is EVALUATED. A
  // lead that already has a booked test drive now satisfies it and moves straight
  // in, where before the dialog opened regardless and asked somebody to
  // re-book what was already booked.
  if (direction === "entry" && !criteria) {
    const remedy = remedyFor(row.entryAction);
    if (remedy) return { mode: DERIVED_GATE_MODE, criteria: derivedCriteria(remedy) };
  }
  return { mode, criteria };
}

/**
 * Decide one move against both stages' rules.
 *
 * Split out of `moveLead` because it needs four things resolved in order — the
 * source stage, both gates, the facts, and the override permission — and because
 * the Attention Centre's `stage_criteria_unmet` signal will want the same
 * resolution against a lead's CURRENT stage.
 */
async function gateStageMove(input: {
  leadId: string;
  user: Awaited<ReturnType<typeof requireLeadAccess>>;
  currentScope: { pipelineId: string; stageId: string };
  targetStage: PipelineStageRow;
}): Promise<
  // `move` is the whole question — both gates, the facts and the override
  // permission — so a remedy path can ask it AGAIN with the facts its own work is
  // about to create. That is the only way to re-judge a rule without
  // reimplementing `and`/`or`/`not`; see the note where `verdictAfterRemedy` used
  // to be in stageGate.ts. `null` when nothing was evaluated at all.
  | { verdict: StageGateVerdict; remedy: StageRemedy | null; move: StageMoveInput | null }
  | { error: string; gate?: StageGateVerdict }
> {
  const { leadId, user, currentScope, targetStage } = input;
  const entry = stageGateFor(targetStage, "entry");
  if (entry === "broken") return { error: BROKEN_RULE_MESSAGE };

  // The source stage is only needed for its EXIT gate, and only inside one
  // pipeline — a cross-pipeline move runs the target's entry gate alone. It is
  // fetched through `getPipelineStage`, which is tenant-filtered, so a stage from
  // another workspace resolves to null and contributes no rule.
  const samePipeline = currentScope.pipelineId === targetStage.pipelineId;
  const fromRow = samePipeline ? await getPipelineStage(currentScope.stageId) : null;
  const exit = fromRow ? stageGateFor(fromRow, "exit") : null;
  if (exit === "broken") return { error: BROKEN_RULE_MESSAGE };

  // Nothing to decide: both gates off or absent. Skips the facts entirely, which
  // is what keeps an ungated board — every board, on the day this ships — paying
  // nothing for this feature.
  const entryLive = entry.mode !== "off" && Boolean(entry.criteria);
  const exitLive = Boolean(exit && exit.mode !== "off" && exit.criteria);
  if (!entryLive && !exitLive) return { verdict: CLEAR_VERDICT, remedy: null, move: null };

  const facts = await stageGateFactsForLead(leadId);
  if (!facts) return { error: "Lead not found." };

  const move: StageMoveInput = {
    from: fromRow && exit ? { stageId: fromRow.id, order: fromRow.order, exit } : null,
    to: { stageId: targetStage.id, order: targetStage.order, entry },
    samePipeline,
    facts,
    canOverride: await hasPermission(user, "leads.override_stage_rules"),
  };
  const verdict = evaluateStageMove(move);

  // WHICH REMEDY TO OFFER, decided HERE rather than by the board.
  //
  // The board used to look at `entryAction` itself and open the booking dialog
  // before calling the server at all — so it could not know whether the work was
  // already done, and every future remedy would have needed another branch in
  // the client. The server evaluates the rule and names the remedy that addresses
  // what actually failed; the board's job shrinks to opening the dialog it is
  // told to.
  //
  // Offered only when the move is not already clear, and only when the remedy
  // addresses one of the unmet clauses: a stage requiring both a quote and a
  // customer link, missing only the quote, must not offer the customer picker.
  //
  // AND ONLY WHEN DOING IT WOULD ACTUALLY GET THE LEAD IN. A remedy that leaves
  // an unoverridable clause still unmet cannot complete the move, and the remedy
  // action refuses before writing anything — so offering the dialog sends someone
  // off to choose a customer, or book a test drive, for a move that was never
  // going to be permitted. Refusing once and naming everything that is missing is
  // better than refusing twice with the work wasted in between.
  const remedy = remedyFor(targetStage.entryAction);
  const addresses = remedy !== null && verdict.unmet.length > 0 && remedyAddresses(remedy, verdict.unmet);
  // Asked of the real evaluator, against the BEST the remedy could achieve.
  //
  // The distinction matters and reading `factsAfterRemedy` here was wrong.
  // That is what the remedy GUARANTEES whatever is chosen — for `link_contact`,
  // only that a customer is attached — so a stage requiring a customer AND that
  // customer's email was refused outright and the picker never opened, even
  // though choosing a customer who has an email satisfies both. The action
  // projects the chosen contact's real email and phone, and that code was
  // unreachable.
  //
  // The offer asks "could ANY choice satisfy this?"; the action asks "does THIS
  // choice satisfy it?". Optimism is safe HERE and only here, because opening a
  // dialog permits nothing — every remedy action re-judges against what actually
  // happened, and refuses naming what is still missing if the choice falls short.
  const worthOffering =
    addresses &&
    evaluateStageMove({ ...move, facts: factsIfRemedyIdeal(move.facts, remedy) }).allowed;
  return { verdict, remedy: worthOffering ? remedy : null, move };
}

const BROKEN_RULE_MESSAGE =
  "A stage rule on this pipeline could not be read, so this move was not allowed. Fix it in Settings → Pipelines.";

/**
 * Move a lead to another stage, reporting a refusal AS A VALUE.
 *
 * This threw. Every other action the Kanban calls — `moveLeadToTestDrive`,
 * `assignLead`, `convertLeadToContact` — already returns `{ ok, error }`, and the
 * board reads `result.error`; `moveLead` was the only one out of step, and the
 * optimistic-move rollback added on this branch is the first code that tries to
 * SHOW what it produced. Next's own guidance is the same
 * (`node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md`:
 * expected errors are return values, not throws), and a permission refusal is the
 * textbook expected error. A thrown message is also liable to reach the browser
 * as an opaque digest in a production build, which would make the rollback toast
 * read out a hash — but the convention and the inconsistency settle it on their
 * own.
 */
export async function moveLead(
  leadId: string,
  stageId: string,
  options?: { overrideReason?: string },
): Promise<{ ok: boolean; error?: string; gate?: StageGateVerdict; remedy?: PipelineStageAction }> {
  const user = await requireLeadAccess(leadId, "leads.change_stage");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  // Same refusal as `updateLead` and `moveLeadToTestDrive`, for the same reason: a
  // lead outside the acting workspace no longer resolves, and a null that fell
  // through would SKIP the cross-pipeline permission check rather than fail it.
  const currentScope = await getLeadPipeline(leadId);
  if (!currentScope) return { ok: false, error: "Lead not found." };
  const resolved = await resolveOpenStage(stageId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const targetStage = resolved.stage;
  if (currentScope.pipelineId !== targetStage.pipelineId && !(await hasPermission(user, "leads.change_pipeline"))) {
    return { ok: false, error: "You do not have permission to move leads between pipelines" };
  }
  // ── STAGE GATES ───────────────────────────────────────────────────────────
  //
  // Runs AFTER permissions and BEFORE the write, and its facts are re-derived
  // here rather than taken from the request. The board runs the same
  // `evaluateStageMove` to grey a column before the drag; that copy is a
  // rendering hint built from a page-load snapshot, and a quote deleted in
  // another tab thirty seconds ago is not in it. Only this one decides.
  const gateOutcome = await gateStageMove({ leadId, user, currentScope, targetStage });
  if ("error" in gateOutcome) return { ok: false, error: gateOutcome.error, gate: gateOutcome.gate };
  const verdict = gateOutcome.verdict;

  // A REMEDY IS OFFERED BEFORE A REFUSAL IS ISSUED.
  //
  // `This stage requires test-drive booking details` used to be returned here for
  // any stage carrying an entryAction, unconditionally — the board caught that
  // stage on the way out and opened the dialog itself, so the message existed
  // only to stop a direct POST. Now the SERVER decides: the rule is evaluated,
  // and when what failed is exactly what a remedy provides, the client is told
  // which dialog to open instead of being refused.
  //
  // The consequence people will notice: a lead that ALREADY has a booked test
  // drive satisfies the criterion and moves straight in, where before the dialog
  // opened regardless and asked for a booking that existed.
  if (gateOutcome.remedy) {
    return { ok: false, gate: verdict, remedy: gateOutcome.remedy.id };
  }

  const overrideReason = options?.overrideReason?.trim() ?? "";
  if (verdict.requiresReason && overrideReason.length < MIN_OVERRIDE_REASON) {
    // Not a refusal — the client opens the reason dialog because the SERVER asked
    // it to, so a POST that skips the dialog gets asked in exactly the same way.
    return { ok: false, gate: verdict };
  }
  if (!verdict.allowed) {
    const message = refusalSentence(verdict, targetStage.name);
    // Best-effort, and noisy by design: a refusal log is how you find out a rule
    // is wrong. `logAudit` rather than `logAuditStrict` because nothing changed
    // and a failed write here must not turn a refusal into an error.
    await logAudit({
      action: "lead.stage_gate_blocked",
      summary: `Blocked “${before.title}” from ${targetStage.name} — ${message}`,
      leadId,
      contactId: before.contactId,
      user,
    });
    return { ok: false, error: message, gate: verdict };
  }

  // THE MOVE AND ITS MANDATORY RECORD COMMIT TOGETHER, OR NEITHER DOES.
  //
  // These were three separate awaits: update, then `lead.stage_changed`, then
  // `lead.stage_gate_overridden`. A strict audit throws on failure, so either
  // audit failing left the lead ALREADY MOVED while the action reported an
  // error — the person retries, against a lead that is now in the target stage.
  // Worse for the override: the whole point of it is that waving a rule through
  // is recorded, and the recording was the part that could be lost.
  //
  // `logAuditStrict`'s own doc says this is what the `tx` parameter is for, and
  // `deleteLead` below already uses the pattern. Resolved BEFORE the transaction
  // opens: `nextPosition` reads the target column, and asking for it inside
  // would query on a different connection while this transaction holds locks.
  // Same reasoning, spelled out at length, in `moveLeadToTestDrive`.
  const position = await nextPosition(stageId);
  const lead = await prisma.$transaction(async (tx) => {
    const moved = await tx.lead.update({
      where: { id: leadId },
      data: { stageId, position, stageEnteredAt: new Date() },
      include: { stage: true },
    });
    await logAuditStrict({
      action: "lead.stage_changed",
      summary: `Moved “${moved.title}” to ${moved.stage.name}`,
      leadId,
      contactId: moved.contactId,
      user,
      before: { stageId: before.stageId, position: before.position, pipelineId: currentScope.pipelineId },
      after: { stageId, position: moved.position, pipelineId: targetStage.pipelineId },
      // A clean move carries nothing extra; a move that went through despite a
      // rule carries what the rule wanted. `logAuditStrict` routes to AuditEvent,
      // the only model with metadata and the only one whose triggers refuse
      // UPDATE and DELETE — an override you can edit afterwards is not a record.
      ...(verdict.unmet.length > 0
        ? { metadata: { gateDirection: verdict.direction, gateMode: verdict.mode, gateUnmet: verdict.unmet.map(describeUnmet) } }
        : {}),
    }, tx);
    if (verdict.requiresReason) {
      // A SEPARATE, differently-named event, not a footnote on the move. "Who has
      // been waving rules through" is a question somebody will ask, and it should
      // be answerable by reading one action name rather than by filtering every
      // stage change for a metadata key.
      await logAuditStrict({
        action: "lead.stage_gate_overridden",
        summary: `Moved “${moved.title}” into ${moved.stage.name} without ${verdict.unmet.map(describeUnmet).join("; ")} — reason: “${overrideReason}”`,
        leadId,
        contactId: moved.contactId,
        user,
        before: { stageId: before.stageId },
        after: { stageId },
        metadata: {
          direction: verdict.direction,
          mode: verdict.mode,
          unmet: verdict.unmet,
          reason: overrideReason,
        },
      }, tx);
    }
    return moved;
  }, GOVERNANCE_TX);
  const pipelineStages = await listPipelineStages(targetStage.pipelineId);
  const testDriveStage = pipelineStages.find((stage) => stage.entryAction === "book_test_drive");
  if (testDriveStage && targetStage.order < testDriveStage.order) {
    const booking = await prisma.activity.findFirst({
      where: { leadId, type: "test_drive", status: "planned" },
      orderBy: { dueDate: "desc" },
    });
    if (booking) {
      await removeTimelinePin("activity", booking.id);
      await prisma.activity.delete({ where: { id: booking.id } });
      await logAudit({
        action: "lead.test_drive_cancelled",
        summary: `Cancelled the booked test drive for “${lead.title}” — moved back to ${lead.stage.name}`,
        leadId,
        contactId: lead.contactId,
        user,
      });
    }
  }

  await emitLeadJourneyEvent("stage_entered", leadId);
  revalidatePath("/leads");
  revalidatePath("/forecast");
  // The verdict rides along on SUCCESS too, not only on refusal. A `warn` gate
  // allows the move and its whole purpose is to say what was missing — returning
  // a bare `{ ok: true }` made that unsayable, so the warning existed in the
  // audit trail and nowhere the person could see it.
  return { ok: true, gate: verdict };
}

export async function moveLeadToTestDrive(
  leadId: string,
  stageId: string,
  data: { productId: string | null; date: string; time: string; location: string },
  options?: { overrideReason?: string },
): Promise<{ ok: boolean; error?: string; gate?: StageGateVerdict }> {
  const user = await requireLeadAccess(leadId, "leads.change_stage");
  const when = new Date(`${data.date}T${data.time || "09:00"}:00+02:00`);
  if (isNaN(when.getTime())) return { ok: false, error: "Pick a valid date and time" };

  const currentScope = await getLeadPipeline(leadId);
  if (!currentScope) return { ok: false, error: "Lead not found." };
  const changingStage = currentScope.stageId !== stageId;
  // Same convention as everything else this function returns: a deleted or closed
  // target stage is an expected outcome, and it reached the board as a generic
  // "Something went wrong" only because it was thrown from here.
  const resolved = await resolveOpenStage(stageId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const targetStage = resolved.stage;
  if (
    currentScope.pipelineId !== targetStage.pipelineId &&
    !(await hasPermission(user, "leads.change_pipeline"))
  ) {
    return { ok: false, error: "You cannot move leads between pipelines." };
  }
  if (targetStage.entryAction !== "book_test_drive") {
    return { ok: false, error: "That stage is not configured for test-drive booking." };
  }

  // THE STAGE'S RULES APPLY ON THIS PATH TOO.
  //
  // A stage may carry BOTH a required action and entry criteria, and the board
  // routes a required-action stage straight to the booking dialog — so `moveLead`,
  // which is where the gate lived, was never called for those stages at all. The
  // rules were silently skipped on exactly the stages most likely to have them.
  //
  // Third bypass of the same shape: the rule has to run on every door into the
  // stage, not on the one the feature was written against.
  let verdict = CLEAR_VERDICT;
  if (changingStage) {
    const gated = await gateStageMove({ leadId, user, currentScope, targetStage });
    if ("error" in gated) return { ok: false, error: gated.error };
    // THE BOOKING THIS CALL IS ABOUT TO WRITE COUNTS AS DONE — and here the
    // omission was total, not narrow. A `book_test_drive` stage carrying no
    // explicit rules DERIVES "test drives booked ≥ 1" at `block`, so this path
    // evaluated "has a test drive" against a lead that did not have one YET and
    // refused. The first booking into such a stage — the primary remedy, and the
    // only one that existed before this branch — could never succeed.
    //
    // Nothing caught it because the tests around this are source-shape tests, and
    // the shape was right; only the arithmetic of "not booked yet" against "must
    // be booked" was wrong.
    //
    // Judged by re-running the REAL evaluator on the facts this booking creates,
    // never by editing the verdict — the criteria tree is where `and`/`or`/`not`
    // live and a flattened list has already lost it.
    verdict = gated.move
      ? evaluateStageMove({
          ...gated.move,
          facts: factsAfterRemedy(gated.move.facts, STAGE_REMEDIES.book_test_drive),
        })
      : gated.verdict;
    const overrideReason = options?.overrideReason?.trim() ?? "";
    if (verdict.requiresReason && overrideReason.length < MIN_OVERRIDE_REASON) {
      // Same contract as `moveLead`: the client is asked for a reason BY THE
      // SERVER, and the booking details it already collected are re-sent with it.
      return { ok: false, gate: verdict };
    }
    if (!verdict.allowed) {
      const message = refusalSentence(verdict, targetStage.name);
      await logAudit({
        action: "lead.stage_gate_blocked",
        summary: `Blocked “${leadId}” from ${targetStage.name} — ${message}`,
        leadId,
        user,
      });
      return { ok: false, error: message, gate: verdict };
    }
  }

  let productId: string | null = null;
  if (data.productId) {
    const product = await prisma.product.findUnique({
      where: { id: data.productId },
      select: { id: true },
    });
    if (!product) return { ok: false, error: "That model is not available." };
    productId = product.id;
  }

  const position = await nextPosition(stageId);
  // Resolved BEFORE the transaction opens, deliberately. Inside it the lead row is
  // locked by the update, and recordTenantId reads on a different connection —
  // asking for the same row there would block on the lock this transaction holds.
  // Both parents are consulted: the composite keys are (tenantId, leadId) AND
  // (tenantId, contactId), so a lead and a contact that disagree must yield NULL
  // rather than a value that fails one of them and rolls the booking back.
  const linkedContact = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { contactId: true },
  });
  const activityTenantId = await customerRecordTenantId({ leadId, contactId: linkedContact?.contactId });
  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: {
        ...(changingStage ? { stageId, position, stageEnteredAt: new Date() } : {}),
        ...(productId ? { productId } : {}),
      },
      include: { stage: true, product: true },
    });
    const activityData = {
      type: "test_drive",
      summary: `Test Drive${updated.product ? ` — ${updated.product.name}` : ""}`,
      note: `${changingStage ? "Booked" : "Rescheduled"} from the pipeline board for ${updated.name}.`,
      location: data.location.trim() || null,
      dueDate: when,
      leadId,
      contactId: updated.contactId,
      assignedToId: updated.assignedToId ?? user.id,
      createdById: user.id,
      tenantId: activityTenantId,
    };
    const existing = await tx.activity.findFirst({
      where: { leadId, type: "test_drive", status: "planned" },
      orderBy: { dueDate: "asc" },
      select: { id: true },
    });
    if (existing) {
      await tx.activity.update({ where: { id: existing.id }, data: activityData });
    } else {
      await tx.activity.create({ data: activityData });
    }
    // INSIDE the transaction, with `tx`. Written after the move and the booking
    // but committed with them: a strict audit throws on failure, and outside this
    // block that left the lead moved AND the test drive booked while the action
    // reported an error — the same partial success that was fixed for ordinary
    // moves, reintroduced on this path when the gate was added to it.
    //
    // The override record is the entire justification for allowing an override,
    // so it is the one thing that must not be the part that goes missing.
    if (verdict.requiresReason) {
      await logAuditStrict({
        action: "lead.stage_gate_overridden",
        summary: `Moved “${updated.title}” into ${updated.stage.name} without ${verdict.unmet.map(describeUnmet).join("; ")} — reason: “${options?.overrideReason?.trim() ?? ""}”`,
        leadId,
        contactId: updated.contactId,
        user,
        after: { stageId },
        metadata: {
          direction: verdict.direction,
          mode: verdict.mode,
          unmet: verdict.unmet,
          reason: options?.overrideReason?.trim() ?? "",
          via: "test_drive_booking",
        },
      }, tx);
    }
    return updated;
  }, GOVERNANCE_TX);

  await logAudit({
    action: "lead.test_drive_booked",
    summary: `${changingStage ? "Booked" : "Rescheduled"} a test drive for “${lead.title}” (${when.toLocaleString("en-ZA", {
      timeZone: "Africa/Johannesburg",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })}${data.location ? ` at ${data.location}` : ""})`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  if (changingStage) await emitLeadJourneyEvent("stage_entered", leadId);
  revalidatePath("/leads");
  revalidatePath("/calendar");
  return { ok: true, gate: verdict };
}

/**
 * Customers this lead could be linked to, for the `link_contact` remedy's picker.
 *
 * A search rather than a full list: the lead detail page renders every contact
 * into a `<select>`, which is fine on a page loaded for one lead and wrong on a
 * board that would then ship the whole customer table to the browser on every
 * render.
 *
 * Scoped by `getAccessibleContactIds`, the same helper every contact surface
 * uses, with its documented contract — `null` is unrestricted, `[]` must become
 * an impossible match rather than an absent filter.
 *
 * ── Why the whole body is inside withActingStaffScope ────────────────────────
 *
 * This is a STANDALONE Server Action: nothing renders it, so nothing above it has
 * bound a workspace. A Server Action has no React request store to carry one, and
 * a scope established by a callee does not reach the frame that called it — so
 * without an enclosing frame here, the guarded reads below fail closed under
 * enforcement and the picker returns nothing with no error the user can act on.
 *
 * The PERMISSION LOOKUP is inside the wrapper, not outside it. `requireAnyPermission`
 * resolves the session and reads role and permission rows through the guarded
 * client, so it needs the scope every bit as much as the contact query does —
 * wrapping only the query would move the failure one line up and look fixed.
 *
 * Same defect as #528 and #529, same shape, same cure. It never widens: an
 * already-bound scope wins and this becomes a bare call.
 */
export async function searchLinkableContacts(
  term: string,
): Promise<Array<{ id: string; label: string; sublabel: string }>> {
  return withActingStaffScope(async () => {
    // Gated on being able to SEE customers, which is what this returns, rather than
    // on a lead id it does not take. `getAccessibleContactIds` then narrows to the
    // ones this caller may actually open.
    const user = await requireAnyPermission("contacts.view_all", "contacts.view_owned");
    const query = term.trim();
    if (query.length < 2) return [];
    const ids = await getAccessibleContactIds(user);
    if (ids !== null && ids.length === 0) return [];
    const contains = { contains: query, mode: "insensitive" as const };
    const rows = await prisma.contact.findMany({
      where: {
        ...(ids === null ? {} : { id: { in: ids } }),
        OR: [{ firstName: contains }, { lastName: contains }, { company: contains }, { email: contains }, { phone: contains }],
      },
      select: { id: true, firstName: true, lastName: true, company: true, isCompany: true, email: true, phone: true },
      orderBy: { updatedAt: "desc" },
      take: 8,
    });
    return rows.map((row) => ({
      id: row.id,
      label: contactName(row),
      sublabel: row.email ?? row.phone ?? "",
    }));
  });
}

/**
 * The `link_contact` remedy: link the customer AND make the move, together.
 *
 * The sibling of `moveLeadToTestDrive`, and the second entry in the registry —
 * which is the point of the registry existing. Everything it does that is not
 * "link a contact" is the same shape: gate the move, do the work and the move in
 * one transaction, audit both, and report the verdict back.
 *
 * `leads.link_contact` is required ON TOP of `leads.change_stage`. The remedy
 * writes a contact link, and a stage rule must not become a way to perform a
 * write the caller is not entitled to make.
 */
export async function moveLeadWithContact(
  leadId: string,
  stageId: string,
  contactId: string,
  options?: { overrideReason?: string },
): Promise<{ ok: boolean; error?: string; gate?: StageGateVerdict }> {
  // Bound the same way as `searchLinkableContacts`, for the same reason — a
  // standalone Server Action has nothing above it holding a workspace — and
  // delegating rather than indenting because the body is a hundred lines and
  // re-indenting it would bury the change in whitespace. The wrapper is still
  // enclosing: everything the inner function calls runs inside the scope.
  return withActingStaffScope(() => moveLeadWithContactInScope(leadId, stageId, contactId, options));
}

async function moveLeadWithContactInScope(
  leadId: string,
  stageId: string,
  contactId: string,
  options?: { overrideReason?: string },
): Promise<{ ok: boolean; error?: string; gate?: StageGateVerdict }> {
  const user = await requireLeadAccess(leadId, "leads.change_stage");
  if (!(await hasPermission(user, "leads.link_contact"))) {
    return { ok: false, error: "You do not have permission to link customers to leads." };
  }
  if (!contactId) return { ok: false, error: "Choose a customer to link." };

  const currentScope = await getLeadPipeline(leadId);
  if (!currentScope) return { ok: false, error: "Lead not found." };
  const changingStage = currentScope.stageId !== stageId;
  const resolved = await resolveOpenStage(stageId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const targetStage = resolved.stage;
  if (
    currentScope.pipelineId !== targetStage.pipelineId &&
    !(await hasPermission(user, "leads.change_pipeline"))
  ) {
    return { ok: false, error: "You cannot move leads between pipelines." };
  }
  if (targetStage.entryAction !== "link_contact") {
    return { ok: false, error: "That stage does not ask for a customer link." };
  }

  // The contact id arrives from the client, so it is resolved through the guarded
  // client — a forged id from another workspace does not exist here.
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    // email and phone are selected for the GATE, not for the link — a stage may
    // ask for "the customer has an email", and after this call that fact is this
    // contact's email. See the re-evaluation below.
    select: {
      id: true,
      tenantId: true,
      firstName: true,
      lastName: true,
      company: true,
      isCompany: true,
      email: true,
      phone: true,
    },
  });
  if (!contact) return { ok: false, error: "That customer is not available in this workspace." };

  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });

  // The gate runs on this door too — see the note on `moveLeadToTestDrive`. The
  // link itself is what satisfies the rule, so the facts are read BEFORE it is
  // written and the verdict describes the move as it stands.
  let verdict = CLEAR_VERDICT;
  if (changingStage) {
    const gated = await gateStageMove({ leadId, user, currentScope, targetStage });
    if ("error" in gated) return { ok: false, error: gated.error };
    // THE LINK THIS CALL IS ABOUT TO WRITE COUNTS AS DONE.
    //
    // This used to be a narrower guard: proceed when the ONLY unmet clause was the
    // link. Right for a stage with one rule, wrong for a stage with two — missing
    // a link AND a value, the guard failed, the pre-link verdict was applied
    // whole, and the move was refused after the customer had been chosen. The
    // remedy the board offered accomplished nothing.
    //
    // The rule is re-run — the REAL evaluator, the same gates — against the facts
    // this call is about to create. Not by editing the verdict: the criteria tree
    // is where `and`, `or` and `not` live, and the flattened `unmet` list has
    // already thrown it away, so subtracting a clause answers
    // `or(linked, quote exists)` wrongly in the permissive direction's opposite —
    // refusing a move the rule plainly allows.
    //
    // The registry's effect is the baseline ("a customer is linked"). Which
    // customer is known HERE and nowhere else, so the facts that depend on the
    // record chosen are filled in exactly rather than left at their pre-link
    // values — a stage asking for a customer WITH an email is satisfied by
    // picking one who has an email, and would otherwise be refused for a fact
    // that is about to be true.
    //
    // What this also fixes without special-casing: the audit below reads
    // `verdict.unmet`, so the override entry no longer lists a customer link as
    // missing in the same transaction that writes one.
    if (gated.move) {
      const base = factsAfterRemedy(gated.move.facts, STAGE_REMEDIES.link_contact);
      verdict = evaluateStageMove({
        ...gated.move,
        facts: { ...base, contact: { ...base.contact, email: contact.email, phone: contact.phone } },
      });
    } else {
      verdict = gated.verdict;
    }
    const overrideReason = options?.overrideReason?.trim() ?? "";
    if (verdict.requiresReason && overrideReason.length < MIN_OVERRIDE_REASON) {
      return { ok: false, gate: verdict };
    }
    if (!verdict.allowed) {
      return { ok: false, error: refusalSentence(verdict, targetStage.name), gate: verdict };
    }
  }

  const position = changingStage ? await nextPosition(stageId) : before.position;
  // The transaction's result is not needed out here — the summaries are built
  // inside it from `updated`, and the revalidation below is keyed on ids the
  // caller already has.
  await prisma.$transaction(async (tx) => {
    // A contact created outside any workspace inherits the lead's, matching
    // `linkLeadToContact` — the same rule, because it is the same link.
    if (contact.tenantId === null && before.tenantId !== null) {
      await tx.contact.update({ where: { id: contactId }, data: { tenantId: before.tenantId } });
    }
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: {
        contactId,
        ...(changingStage ? { stageId, position, stageEnteredAt: new Date() } : {}),
      },
      include: { stage: true, contact: true },
    });
    await logAuditStrict({
      action: "lead.contact_linked",
      summary: `Linked “${updated.title}” to ${contactName(contact)}${changingStage ? ` and moved it to ${updated.stage.name}` : ""}`,
      leadId,
      contactId,
      user,
      before: { contactId: before.contactId, stageId: before.stageId },
      after: { contactId, stageId: updated.stageId },
    }, tx);
    if (changingStage) {
      await logAuditStrict({
        action: "lead.stage_changed",
        summary: `Moved “${updated.title}” to ${updated.stage.name}`,
        leadId,
        contactId,
        user,
        before: { stageId: before.stageId, position: before.position, pipelineId: currentScope.pipelineId },
        after: { stageId, position: updated.position, pipelineId: targetStage.pipelineId },
      }, tx);
    }
    if (verdict.requiresReason && options?.overrideReason?.trim()) {
      await logAuditStrict({
        action: "lead.stage_gate_overridden",
        summary: `Moved “${updated.title}” into ${updated.stage.name} without ${verdict.unmet.map(describeUnmet).join("; ")} — reason: “${options.overrideReason.trim()}”`,
        leadId,
        contactId,
        user,
        after: { stageId },
        metadata: {
          direction: verdict.direction,
          mode: verdict.mode,
          unmet: verdict.unmet,
          reason: options.overrideReason.trim(),
          via: "contact_link",
        },
      }, tx);
    }
    return updated;
  }, GOVERNANCE_TX);

  if (changingStage) await emitLeadJourneyEvent("stage_entered", leadId);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/forecast");
  return { ok: true, gate: verdict };
}

export async function assignLead(leadId: string, assignedToId: string) {
  const user = await requireLeadAccess(leadId, "leads.assign");
  // Same shared contract as everywhere else, but this call site RETURNS its
  // refusal rather than throwing it, and that difference is deliberate: the
  // kanban board assigns by drag, catches the result and shows `error` in a
  // toast, so a throw here would surface as "Something went wrong" instead of
  // the reason. The catch keeps that shape — and keeps the exact sentence the
  // board has always shown — while the membership question itself is no longer
  // answered by a private copy of the rule.
  const assignee = await resolveAssignableUser(assignedToId, ASSIGNEE_LABEL).catch(() => null);
  if (!assignee) return { ok: false as const, error: "That team member is no longer available." };

  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { assignedToId: assignee.id },
  });
  await logAuditStrict({
    action: "lead.assigned",
    summary: `Assigned lead “${lead.title}” to ${assignee.name}`,
    leadId,
    contactId: lead.contactId,
    user,
    before,
    after: lead,
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/forecast");
  return { ok: true as const, assignee };
}

export async function markLeadViewed(leadId: string) {
  await requireLeadReadAccess(leadId);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { viewedAt: true } });
  if (lead && !lead.viewedAt) {
    await prisma.lead.update({ where: { id: leadId }, data: { viewedAt: new Date() } });
    revalidatePath("/leads");
  }
}

export async function markWon(leadId: string, formData?: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.mark_won");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    let contactId = before.contactId;
    if (!contactId) {
      const [firstName, ...rest] = before.name.split(/\s+/);
      const contact = await prisma.contact.create({
        data: {
          firstName: firstName || before.name,
          lastName: rest.join(" ") || null,
          email: before.email,
          phone: before.phone,
          source: before.source,
          // Carried, for the same reason as createLead: winning a lead must not
          // be the moment its notes disappear. notesFromLeadId records WHERE the
          // copy came from, so the timeline can show one entry instead of two
          // without comparing sentences — see lib/timelineNotes.ts.
          notes: before.notes,
          notesFromLeadId: before.notes?.trim() ? before.id : null,
          tenantId: before.tenantId,
          createdById: user.id,
          ownerId: before.assignedToId ?? user.id,
        },
      });
      contactId = contact.id;
      await logAudit({
        action: "contact.created",
        summary: `Created contact ${before.name} from won lead`,
        contactId,
        leadId,
        user,
        after: contact,
      });
    }
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { status: "won", contactId },
    });
    await markReferralEarned(leadId).catch(() => {});
    await emitLeadJourneyEvent("lead_won", leadId);
    await logAuditStrict({
      action: "lead.won",
      summary: `Marked lead “${lead.title}” as WON 🎉`,
      leadId,
      contactId,
      user,
      before,
      after: lead,
    });
    await triggerSurvey("won", { contactId, leadId });
    revalidatePath("/leads");
    revalidatePath("/forecast");
    revalidatePath(`/leads/${leadId}`);
    // A real success that simply stays put: the win IS recorded, this only skips
    // the hop to the contact. Said explicitly so it cannot be mistaken for one of
    // the silent "nothing happened" returns.
    if (formData?.get("returnTo") === "/leads") return { success: "Marked won" };
    return { redirectTo: `/contacts/${contactId}` };
  });
}

export async function markLost(leadId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.mark_lost");
    const reason = String(formData.get("lostReason") ?? "").trim();
    if (!reason) throw new ActionRefusal("A lost reason is required");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { status: "lost", lostReason: reason },
    });
    await emitLeadJourneyEvent("lead_lost", leadId);
    await logAuditStrict({
      action: "lead.lost",
      summary: `Marked lead “${lead.title}” as lost — ${reason}`,
      leadId,
      contactId: lead.contactId,
      user,
      before,
      after: lead,
    });
    revalidatePath("/leads");
    revalidatePath("/forecast");
    revalidatePath(`/leads/${leadId}`);
  });
}

export async function reopenLead(leadId: string) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.reopen");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { status: "open", lostReason: null },
    });
    await logAuditStrict({
      action: "lead.reopened",
      summary: `Reopened lead “${lead.title}”`,
      leadId,
      contactId: lead.contactId,
      user,
      before,
      after: lead,
    });
    revalidatePath("/leads");
    revalidatePath("/forecast");
    revalidatePath(`/leads/${leadId}`);
  });
}

export async function linkLeadToContact(leadId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.link_contact");
    const contactId = String(formData.get("contactId") ?? "");
    if (!contactId) refuse("Choose a contact to link.");
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, tenantId: true } });
    if (!contact) throw new ActionRefusal("Contact not found");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (contact.tenantId === null && before.tenantId !== null) {
      await prisma.contact.update({ where: { id: contactId }, data: { tenantId: before.tenantId } });
    }
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { contactId },
      include: { contact: true },
    });
    await logAuditStrict({
      action: "lead.contact_linked",
      summary: `Linked lead “${lead.title}” to contact ${lead.contact ? `${lead.contact.firstName} ${lead.contact.lastName ?? ""}`.trim() : ""}`,
      leadId,
      contactId,
      user,
      before: { contactId: before.contactId },
      after: { contactId },
    });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
  });
}

export async function convertLeadToContact(leadId: string): Promise<{ ok: boolean; error?: string; contactId?: string }> {
  try {
    const user = await requireLeadAccess(leadId, "leads.link_contact");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });

    if (lead.contactId) return { ok: false, error: "Already linked to a contact" };

    const matchers = [
      ...(lead.email ? [{ email: lead.email }] : []),
      ...(lead.phone ? [{ phone: lead.phone }] : []),
    ];
    const existingMatch = matchers.length > 0
      ? await prisma.contact.findFirst({ where: { OR: matchers } })
      : null;
    // Reuse if tenantId already matches, or if it's null (pre-backfill) — stamp
    // the lead's tenantId onto it so the composite FK is satisfied without
    // creating a duplicate.
    const canReuse = existingMatch && (
      existingMatch.tenantId === lead.tenantId || existingMatch.tenantId === null
    );

    let contactId: string;
    if (canReuse && existingMatch) {
      contactId = existingMatch.id;
      if (existingMatch.tenantId === null && lead.tenantId !== null) {
        await prisma.contact.update({
          where: { id: existingMatch.id },
          data: { tenantId: lead.tenantId },
        });
      }
    } else {
      const [firstName, ...rest] = lead.name.split(/\s+/);
      const contact = await prisma.contact.create({
        data: {
          firstName: firstName || lead.name,
          lastName: rest.join(" ") || null,
          email: lead.email,
          phone: lead.phone,
          source: lead.source,
          // Converting is explicitly "this lead is now a customer". Losing the
          // notes at that point loses the reason the customer exists.
          notes: lead.notes,
          notesFromLeadId: lead.notes?.trim() ? lead.id : null,
          tenantId: lead.tenantId,
          createdById: user.id,
          ownerId: lead.assignedToId ?? user.id,
        },
      });
      contactId = contact.id;
      await logAudit({
        action: "contact.created",
        summary: `Created contact ${lead.name} from lead`,
        contactId,
        leadId,
        user,
        after: contact,
      });
    }

    await prisma.lead.update({ where: { id: leadId }, data: { contactId } });
    await logAuditStrict({
      action: "lead.contact_linked",
      summary: `Linked lead "${lead.title}" to contact`,
      leadId,
      contactId,
      user,
      before: { contactId: lead.contactId },
      after: { contactId },
    });

    revalidatePath("/leads");
    revalidatePath("/contacts");
    revalidatePath(`/leads/${leadId}`);

    return { ok: true, contactId };
  } catch (err: unknown) {
    // Re-throw Next.js redirect errors so they navigate properly
    if (err && typeof err === "object" && "digest" in err) {
      const digest = (err as { digest: unknown }).digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[convertLeadToContact]", message);
    return { ok: false, error: message };
  }
}

export async function deleteLead(leadId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.delete");
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    // The delete and the audit that records it commit together. Separately, a
    // failing audit left the lead deleted while telling the operator it had not
    // been — and the retry then reported "not found", which is what happened in
    // production on 2026-08-07.
    const lead = await basePrisma.$transaction(async (tx) => {
      const deleted = await softDeleteRecord("lead", leadId, reason, user.name, tx);
      // Nothing matched — another tenant's id, or already gone. Never audit a
      // deletion that did not happen.
      if (!deleted) return null;
      await logAuditStrict({
        action: "trash.deleted",
        summary: `Moved lead “${deleted.title}” to trash — ${reason}`,
        leadId,
        contactId: deleted.contactId,
        user,
        before,
        after: { deletedAt: deleted.deletedAt, deleteReason: reason },
      }, tx);
      return deleted;
    }, GOVERNANCE_TX);
    if (!lead) refuse("That lead could not be found.");
    revalidatePath("/leads");
    revalidatePath("/forecast");
    return { redirectTo: "/leads" };
  });
}
