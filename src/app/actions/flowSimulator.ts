"use server";

import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { coloursList, priceList } from "@/lib/botAnswers";
import { runFlow, type Flow, type FlowInput, type FlowSession, type OutMsg } from "@/lib/flow";
import { flowScope } from "@/lib/flowScope";
import { withActingStaffScope } from "@/lib/actingScope";

export type SimulatorTurnInput = {
  flowId: string;
  session: FlowSession | null;
  text?: string;
  choiceId?: string;
  fileUrl?: string;
  simulateAiHandoff?: boolean;
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
    const flow = parseFlow(row.definition);
    if (!flow) return { ok: false, error: "Flow data is malformed.", messages: [], session: null, handedOff: false, trace: [], vars: {} };

    const session: FlowSession = input.session ?? { nodeId: null, vars: { greeting: "Hi there 👋 Welcome to Denago Cape Town!", first_name: "Test", name: "Test" } };
    const trace: string[] = [`Enter: ${session.nodeId ?? flow.start}`];
    const turn: FlowInput = { text: input.text ?? "", ...(input.choiceId ? { choiceId: input.choiceId } : {}), ...(input.fileUrl ? { fileUrl: input.fileUrl } : {}) };

    try {
      const result = await runFlow(flow, session, turn, {
        dynamicAnswer: async (source) => source === "colours" ? coloursList() : priceList(),
        aiReply: async () => {
          const handoff = Boolean(input.simulateAiHandoff);
          trace.push(handoff ? "AI: simulated handoff" : "AI: simulated answer");
          return { reply: handoff ? "[Simulator] AI would hand this conversation to a person." : "[Simulator] AI response — production uses approved knowledge and live CRM product facts.", handoff };
        },
        availableSlots: async () => [
          { id: "2030-01-15_09:00", label: "Tue 15 Jan · 09:00 (simulated)" },
          { id: "2030-01-15_11:00", label: "Tue 15 Jan · 11:00 (simulated)" },
          { id: "2030-01-16_14:00", label: "Wed 16 Jan · 14:00 (simulated)" },
        ],
        bookSlot: async (slotId, _vars, nodeId) => {
          trace.push(`CRM: node ${nodeId} would reserve slot ${slotId}`);
          return { ok: true, label: simulatedSlotLabel(slotId) };
        },
        rescheduleSlot: async (slotId, vars, nodeId) => {
          trace.push(`CRM: node ${nodeId} would move booking ${vars.booking_id || "[missing booking]"} to ${slotId}`);
          vars.booking_rescheduled = "yes";
          vars.booking_slot = simulatedSlotLabel(slotId);
          return { ok: true, label: vars.booking_slot };
        },
        manageBooking: async (action, vars, nodeId) => {
          if (action === "lookup") {
            trace.push(`CRM: node ${nodeId} would look up this customer's next booking`);
            // The simulator models a customer the CHANNEL identified — the only kind
            // production will act for. Without this the booking starter always fell
            // to its "I can only manage a booking from the number it was made with"
            // branch, so an operator testing the template concluded it was broken.
            vars.booking_identity = "verified";
            vars.booking_found = "yes";
            vars.booking_id = "simulated-activity-id";
            vars.booking_slot = "Tue 15 Jan · 09:00 (simulated)";
            vars.booking_summary = "Simulated service booking";
            return { ok: true };
          }
          trace.push(`CRM: node ${nodeId} would cancel booking ${vars.booking_id || "[missing booking]"}`);
          vars.booking_cancelled = vars.booking_id ? "yes" : "no";
          return { ok: Boolean(vars.booking_id) };
        },
        startJourney: async (journeyId, vars, nodeId) => {
          trace.push(`Journey: node ${nodeId} would enrol this customer in ${journeyId}`);
          vars.journey_started = "yes";
          vars.journey_reason = "simulated enrolment";
          vars.journey_run_id = "simulated-journey-run";
          return { ok: true, reason: "simulated enrolment" };
        },
        createBooking: async (_vars, action, nodeId) => { trace.push(`CRM: node ${nodeId} would create ${action ?? "service"}`); return { ok: true }; },
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
