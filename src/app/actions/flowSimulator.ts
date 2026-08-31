"use server";

import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { coloursList, priceList } from "@/lib/botAnswers";
import { runFlow, type Flow, type FlowInput, type FlowSession, type OutMsg } from "@/lib/flow";
import { flowScope } from "@/lib/flowScope";
import { withActingStaffScope } from "@/lib/actingScope";
import { getCompanyProfile } from "@/lib/companyProfile";
import { DEFAULT_SIMULATOR_SCENARIO, type SimulatorScenario } from "@/lib/flowSimulatorScenario";

export type SimulatorTurnInput = {
  flowId: string;
  /** Optional in-memory editor graph. It is executed read-only after ownership is checked. */
  draftDefinition?: string;
  session: FlowSession | null;
  text?: string;
  choiceId?: string;
  fileUrl?: string;
  scenario?: SimulatorScenario;
};
export type SimulatorTurnResult = { ok: boolean; error?: string; messages: OutMsg[]; session: FlowSession | null; handedOff: boolean; trace: string[]; vars: Record<string, string> };

function parseFlow(definition: string): Flow | null {
  try { const parsed = JSON.parse(definition); return parsed?.start && parsed?.nodes?.[parsed.start] ? parsed as Flow : null; } catch { return null; }
}
function simulatedSlotLabel(slotId: string): string {
  const [date, time] = slotId.split("_"); return date && time ? `${date} · ${time}` : slotId || "Simulated slot";
}

/** Production graph engine + explicitly non-writing effects. */
export async function simulateFlowTurn(input: SimulatorTurnInput): Promise<SimulatorTurnResult> {
  return withActingStaffScope(async () => {
    await requireOwner();
    const scope = await flowScope();
    const row = await prisma.botFlow.findFirst({ where: { id: input.flowId, ...scope } });
    if (!row) return { ok: false, error: "Flow not found.", messages: [], session: null, handedOff: false, trace: [], vars: {} };
    const requestedDefinition = input.draftDefinition?.trim();
    if (requestedDefinition && requestedDefinition.length > 250_000) return { ok: false, error: "The draft is too large to simulate.", messages: [], session: null, handedOff: false, trace: [], vars: {} };
    const flow = parseFlow(requestedDefinition || row.definition);
    if (!flow) return { ok: false, error: "Flow data is malformed.", messages: [], session: null, handedOff: false, trace: [], vars: {} };

    const scenario = { ...DEFAULT_SIMULATOR_SCENARIO, ...input.scenario };
    const session: FlowSession = input.session ?? { nodeId: null, vars: { greeting: `Hi there 👋 Welcome to ${(await getCompanyProfile()).name}!`, first_name: "Test", name: "Test" } };
    const trace: string[] = [`Enter: ${session.nodeId ?? flow.start}`, `Scenario: AI ${scenario.ai} · CRM ${scenario.crm} · slots ${scenario.slots}`];
    const turn: FlowInput = { text: input.text ?? "", ...(input.choiceId ? { choiceId: input.choiceId } : {}), ...(input.fileUrl ? { fileUrl: input.fileUrl } : {}) };

    try {
      const result = await runFlow(flow, session, turn, {
        dynamicAnswer: async (source) => source === "colours" ? coloursList() : priceList(),
        aiReply: async () => {
          if (scenario.ai === "timeout") {
            trace.push("AI: simulated provider timeout");
            return { reply: "Let me get one of our team to help — I'll pass this on now 👍", handoff: true };
          }
          const handoff = scenario.ai === "handoff";
          trace.push(handoff ? "AI: simulated handoff" : "AI: simulated answer");
          return { reply: handoff ? "[Simulator] AI would hand this conversation to a person." : "[Simulator] AI response — production uses approved knowledge and live CRM product facts.", handoff };
        },
        availableSlots: async () => scenario.slots === "none" ? [] : [
          { id: "2030-01-15_09:00", label: "Tue 15 Jan · 09:00 (simulated)" },
          { id: "2030-01-15_11:00", label: "Tue 15 Jan · 11:00 (simulated)" },
          { id: "2030-01-16_14:00", label: "Wed 16 Jan · 14:00 (simulated)" },
        ],
        bookSlot: async (slotId, _vars, nodeId) => {
          trace.push(`CRM: node ${nodeId} would reserve slot ${slotId}`);
          if (scenario.slots === "race_lost") {
            trace.push(`Slots: ${slotId} was taken before the simulated reservation completed`);
            return { ok: false, reason: "simulated slot race lost" };
          }
          if (scenario.crm === "failure") return { ok: false, reason: "simulated CRM refusal" };
          return { ok: true, label: simulatedSlotLabel(slotId) };
        },
        rescheduleSlot: async (slotId, vars, nodeId) => {
          trace.push(`CRM: node ${nodeId} would move booking ${vars.booking_id || "[missing booking]"} to ${slotId}`);
          const ok = scenario.crm === "success";
          vars.booking_rescheduled = ok ? "yes" : "no";
          if (ok) vars.booking_slot = simulatedSlotLabel(slotId);
          return { ok, label: ok ? vars.booking_slot : undefined };
        },
        manageBooking: async (action, vars, nodeId) => {
          if (action === "lookup") {
            trace.push(`CRM: node ${nodeId} would look up this customer's next booking`);
            // The simulator models a customer the CHANNEL identified — the only kind
            // production will act for. Without this the booking starter always fell
            // to its "I can only manage a booking from the number it was made with"
            // branch, so an operator testing the template concluded it was broken.
            vars.booking_identity = scenario.bookingIdentity;
            vars.booking_found = scenario.bookingIdentity === "verified" && scenario.bookingLookup === "found" ? "yes" : "no";
            if (vars.booking_found !== "yes") return { ok: true };
            vars.booking_id = "simulated-activity-id";
            vars.booking_slot = "Tue 15 Jan · 09:00 (simulated)";
            vars.booking_summary = "Simulated service booking";
            return { ok: true };
          }
          trace.push(`CRM: node ${nodeId} would cancel booking ${vars.booking_id || "[missing booking]"}`);
          const ok = scenario.crm === "success" && Boolean(vars.booking_id);
          vars.booking_cancelled = ok ? "yes" : "no";
          return { ok };
        },
        startJourney: async (journeyId, vars, nodeId) => {
          trace.push(`Journey: node ${nodeId} would enrol this customer in ${journeyId}`);
          const ok = scenario.journey === "success";
          vars.journey_started = ok ? "yes" : "no";
          vars.journey_reason = ok ? "simulated enrolment" : "simulated Journey refusal";
          if (ok) vars.journey_run_id = "simulated-journey-run";
          return { ok, reason: vars.journey_reason };
        },
        createBooking: async (_vars, action, nodeId) => { trace.push(`CRM: node ${nodeId} would create ${action ?? "service"}`); return { ok: scenario.crm === "success", reason: scenario.crm === "failure" ? "simulated CRM refusal" : undefined }; },
        handoff: async () => { trace.push("Handoff: would pause bot and notify team"); },
      });

      for (const message of result.messages) trace.push(message.type === "choice" ? `Output: menu (${message.options.length} options)` : `Output: ${message.type}`);
      trace.push(result.handedOff ? "Stop: handed off" : result.session?.nodeId ? `Wait: ${result.session.nodeId}` : "Stop: flow ended");
      return { ok: true, messages: result.messages, session: result.session, handedOff: result.handedOff, trace, vars: result.session?.vars ?? session.vars };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Simulation failed.", messages: [], session, handedOff: false, trace: [...trace, "Error: simulation stopped"], vars: session.vars };
    }
  });
}
