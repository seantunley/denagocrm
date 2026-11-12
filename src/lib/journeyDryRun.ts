/**
 * JOURNEY DRY RUN (Sean, 2026-11-04): walk a Journey the way the engine would — same cursor, same branch and repeat
 * logic, same conditions — on a pretend clock, and SAY what each step would do instead of doing it.
 *
 * Safe by construction, not by a flag: this module imports only the engine's PURE pieces (journeyScript,
 * journeyStepControl, journeyTypes, journeyVariables). The executor that sends mail, SMS and push and writes the CRM
 * (journeyStepExecutor) and the database are never imported, so nothing here CAN send or write — and
 * tests/journeyDryRun.test.ts fails if that import list ever changes.
 */
import { ConditionFailed, StopJourney, AbortJourney } from "./journeyControlFlow";
import { flatCursor, withRepeatVars, clearWait, type JourneyCursor } from "./journeyCursor";
import { advanceCursor, chooseBranch, enterChoose, enterRepeat, JourneyScriptCache, pushFrame, resolveCursor, type ScriptLookup } from "./journeyScript";
import { conditionStepOutcome, stopStepOutcome } from "./journeyStepControl";
import {
  evaluateConditions,
  parseJourneyDefinition,
  parseVariablesConfig,
  parseWaitForConditionConfig,
  parseWaitForTriggerConfig,
  type JourneyDefinition,
  type JourneyStep,
} from "./journeyTypes";
import { applyJourneyVariables, journeyVars, withJourneyVars } from "./journeyVariables";
import { renderTemplate } from "./template";

/** What the person testing decides, where a real run would wait on the world. */
export type DryRunScenario = {
  /** ISO time the run starts. Default: now. */
  start?: string;
  /** A condition or "wait until" step forced true/false. Absent = decided from the lead's real data. */
  conditions?: Record<string, boolean>;
  /** A "wait for something to happen" step: the event arrives, or the wait times out. Default: arrives. */
  triggers?: Record<string, "arrives" | "times_out">;
};

export type DryRunStep = {
  path: string;
  stepId: string;
  type: string;
  /** The pretend time the step runs. */
  at: string;
  outcome: "would_do" | "decided" | "waited" | "skipped" | "stopped" | "failed";
  note: string;
  /** Journey variables after the step, when a step set any. */
  vars?: Record<string, unknown>;
  /** A decision the scenario can flip: the condition's answer, or whether the awaited event happened. */
  answer?: boolean;
};

export type DryRunResult = { steps: DryRunStep[]; ended: "finished" | "stopped" | "step_limit"; endedAt: string };

/** The cap on steps walked: well below the engine's 500, enough for any real Journey, and it ends a runaway loop. */
export const DRY_RUN_MAX_STEPS = 300;

const MINUTE = 60_000;
const unitMs = (unit: unknown) => (unit === "minutes" ? MINUTE : unit === "hours" ? 60 * MINUTE : 1440 * MINUTE);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** What a step that acts on the world WOULD do — in words, from its own config. Nothing is sent or written. */
function wouldDo(step: JourneyStep, vars: Record<string, string>): string {
  const c = step.config;
  const r = (value: unknown) => renderTemplate(text(value), vars).trim();
  switch (step.type) {
    case "send_email": return c.emailTemplateId ? "Would send an email from a saved template" : `Would send an email: “${r(c.subject) || "(no subject)"}”`;
    case "send_sms": return `Would send an SMS: “${r(c.message).slice(0, 160)}”`;
    case "send_push": return `Would send a push notification to staff: “${r(c.message)}”`;
    case "create_activity": return `Would create a ${text(c.activityType) || "to-do"} task${c.summary ? `: “${r(c.summary)}”` : ""}, due in ${Math.max(0, Number(c.dueDays ?? 1) || 0)} day(s)`;
    case "move_stage": return "Would move the deal to another stage";
    case "assign_user": return "Would assign the lead to a salesperson";
    case "lead_mark_won": return "Would mark the lead as won";
    case "lead_mark_lost": return `Would mark the lead as lost${c.reason ? ` (${r(c.reason)})` : ""}`;
    case "lead_reopen": return "Would reopen the lead";
    case "add_tag": return "Would add a tag";
    case "remove_tag": return "Would remove a tag";
    case "set_field": return c.key ? `Would set the ${c.entity === "contact" ? "contact" : "lead"}'s “${text(c.key)}” to “${text(c.value)}”` : "Would set a field (none chosen yet)";
    case "send_review_request": return "Would send a review request";
    case "send_service_reminder": return "Would send a service reminder";
    case "send_signing_reminder": return "Would send a signing reminder";
    case "send_survey_reminder": return "Would send a survey reminder";
    default: return `Would run “${step.type}”`;
  }
}

export function dryRunJourney(input: {
  definition: unknown;
  /** The lead's context as the engine loads it (journeyContext.loadJourneyContext), or {} for no lead. */
  context: Record<string, unknown>;
  scenario?: DryRunScenario;
  /** journeyContext.journeyTemplateVars — passed in so this module stays free of the database. */
  templateVars: (context: Record<string, unknown>) => Record<string, string>;
}): DryRunResult {
  const scenario = input.scenario ?? {};
  const definition: JourneyDefinition = parseJourneyDefinition(input.definition);
  // Its own cache: a draft must never share prepared branches with a published version.
  const lookup: ScriptLookup = { cache: new JourneyScriptCache(), versionId: "dry-run" };
  let clock = scenario.start ? new Date(scenario.start).getTime() : Date.now();
  if (!Number.isFinite(clock)) clock = Date.now();
  let context = input.context;
  let cursor: JourneyCursor = flatCursor(definition.startStepId);
  const steps: DryRunStep[] = [];
  const log = (at: { step: JourneyStep; path: string }, outcome: DryRunStep["outcome"], note: string, extra: Pick<DryRunStep, "vars" | "answer"> = {}) =>
    steps.push({ path: at.path, stepId: at.step.id, type: at.step.type, at: new Date(clock).toISOString(), outcome, note, ...extra });
  const end = (ended: DryRunResult["ended"]): DryRunResult => ({ steps, ended, endedAt: new Date(clock).toISOString() });

  try {
    for (let walked = 0; walked < DRY_RUN_MAX_STEPS; walked++) {
      const position = resolveCursor(definition, cursor, lookup);
      if (!position) return end("finished");
      const { step, keyPath } = position;
      const inSequence = cursor.frames.length > 0;
      const stepContext = withRepeatVars(context, cursor);
      const next = (override?: string | null) => {
        cursor = advanceCursor({ definition, cursor, context: stepContext, lookup, ...(override !== undefined ? { override } : {}) });
      };

      if (step.enabled === false) { log(position, "skipped", "Skipped: this step is turned off"); next(); continue; }

      if (step.type === "choose" || step.type === "repeat") {
        const entered = step.type === "choose"
          ? (() => { const picked = chooseBranch(step, keyPath, stepContext, lookup); return picked ? enterChoose(step, picked.option) : null; })()
          : enterRepeat(step, keyPath, stepContext, lookup);
        log(position, "decided", entered ? (entered.kind === "choose" ? `Chose branch ${entered.option}` : "Entered repeat") : step.type === "choose" ? "No branch matched" : "Repeat skipped: nothing to iterate");
        if (entered) cursor = pushFrame(cursor, entered); else next();
        continue;
      }

      if (step.type === "wait_for_trigger") {
        const config = parseWaitForTriggerConfig(step.config);
        if ((scenario.triggers?.[step.id] ?? "arrives") === "arrives") {
          log(position, "waited", `Waited for ${config.triggers.join(" or ")} — it happened`, { answer: true });
        } else {
          clock += config.timeoutMinutes * MINUTE;
          log(position, "waited", `Waited for ${config.triggers.join(" or ")} — timed out after ${config.timeoutMinutes} minutes (your scenario)`, { answer: false });
          if (!config.continueOnTimeout) return end("stopped");
        }
        cursor = clearWait(cursor); next();
        continue;
      }

      if (step.type === "wait_for_condition") {
        const config = parseWaitForConditionConfig(step.config);
        const met = scenario.conditions?.[step.id] ?? evaluateConditions(config.condition, stepContext);
        if (!met) clock += config.timeoutMinutes * MINUTE;
        log(position, "waited", met ? "Waited until the condition was true — it already was" : `The condition never came true — timed out after ${config.timeoutMinutes} minutes`, { answer: met });
        if (!met && !config.continueOnTimeout) return end("stopped");
        cursor = clearWait(cursor); next();
        continue;
      }

      if (step.type === "variables") {
        const assignments = parseVariablesConfig(step.config);
        const applied = applyJourneyVariables({ stepId: step.id, assignments, existing: journeyVars(context), templateVars: input.templateVars(stepContext) });
        context = withJourneyVars(context, applied.vars);
        log(position, "decided", `Set ${assignments.map((a) => a.name).join(", ")}`, { vars: applied.vars });
        cursor = advanceCursor({ definition, cursor, context: withRepeatVars(context, cursor), lookup });
        continue;
      }

      if (step.type === "wait") {
        const amount = Math.max(1, Number(step.config.amount) || 1);
        clock += amount * unitMs(step.config.unit);
        log(position, "waited", `Waited ${amount} ${text(step.config.unit) || "days"}`);
        next();
        continue;
      }

      if (step.type === "condition") {
        const forced = scenario.conditions?.[step.id];
        if (forced === undefined) {
          const outcome = conditionStepOutcome(step, stepContext, inSequence); // a failing gate throws ConditionFailed
          log(position, "decided", outcome.note, { answer: outcome.output?.passed === true });
          next(outcome.branch ? outcome.branch.stepId : undefined);
        } else if (inSequence) {
          if (!forced) throw new ConditionFailed("Condition did not match (your scenario)");
          log(position, "decided", "Condition matched (your scenario)", { answer: true });
          next();
        } else {
          const configured = forced ? step.config.trueStepId : step.config.falseStepId;
          log(position, "decided", forced ? "Condition matched (your scenario)" : "Condition did not match (your scenario)", { answer: forced });
          next(typeof configured === "string" && configured ? configured : step.nextStepId ?? null);
        }
        continue;
      }

      if (step.type === "stop") stopStepOutcome(step); // always throws StopJourney

      log(position, "would_do", wouldDo(step, input.templateVars(stepContext)));
      next();
    }
    return end("step_limit");
  } catch (error) {
    if (error instanceof StopJourney || error instanceof ConditionFailed) {
      const last = resolveCursor(definition, cursor, lookup);
      if (last) log(last, "stopped", error instanceof ConditionFailed ? `${error.message} — the run ends here` : "Stop: the run ends here", error instanceof ConditionFailed ? { answer: false } : {});
      return end("stopped");
    }
    const last = resolveCursor(definition, cursor, lookup);
    if (last) log(last, "failed", error instanceof AbortJourney || error instanceof Error ? error.message : "The journey could not continue");
    return end("stopped");
  }
}
