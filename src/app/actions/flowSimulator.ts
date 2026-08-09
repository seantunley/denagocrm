"use server";

import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { coloursList, priceList } from "@/lib/botAnswers";
import { runFlow, type Flow, type FlowInput, type FlowSession, type OutMsg } from "@/lib/flow";

export type SimulatorTurnInput = {
  flowId: string;
  session: FlowSession | null;
  text?: string;
  choiceId?: string;
  fileUrl?: string;
  simulateAiHandoff?: boolean;
};

export type SimulatorTurnResult = {
  ok: boolean;
  error?: string;
  messages: OutMsg[];
  session: FlowSession | null;
  handedOff: boolean;
  trace: string[];
  vars: Record<string, string>;
};

function parseFlow(definition: string): Flow | null {
  try {
    const parsed = JSON.parse(definition);
    return parsed?.start && parsed?.nodes?.[parsed.start] ? parsed as Flow : null;
  } catch {
    return null;
  }
}

function simulatedSlotLabel(slotId: string): string {
  const [date, time] = slotId.split("_");
  if (date && time) return `${date} · ${time}`;
  return slotId || "Simulated slot";
}

/** Execute one customer turn through the production graph with non-writing effects. */
export async function simulateFlowTurn(input: SimulatorTurnInput): Promise<SimulatorTurnResult> {
  await requireOwner();
  const row = await prisma.botFlow.findUnique({ where: { id: input.flowId } });
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
        return { reply: handoff ? "[Simulator] AI would hand this conversation to a person." : "[Simulator] AI response — production uses the configured approved brief, FAQs and live product data.", handoff };
      },
      availableSlots: async () => [
        { id: "2030-01-15_09:00", label: "Tue 15 Jan · 09:00 (simulated)" },
        { id: "2030-01-15_11:00", label: "Tue 15 Jan · 11:00 (simulated)" },
        { id: "2030-01-16_14:00", label: "Wed 16 Jan · 14:00 (simulated)" },
      ],
      bookSlot: async (slotId) => { trace.push(`CRM: would reserve slot ${slotId}`); return { ok: true, label: simulatedSlotLabel(slotId) }; },
      createBooking: async (_vars, action) => { trace.push(`CRM: would create ${action ?? "service"}`); },
      handoff: async () => { trace.push("Handoff: would pause bot and notify team"); },
    });
    for (const message of result.messages) trace.push(message.type === "choice" ? `Output: menu (${message.options.length} options)` : `Output: ${message.type}`);
    trace.push(result.handedOff ? "Stop: handed off" : result.session?.nodeId ? `Wait: ${result.session.nodeId}` : "Stop: flow ended");
    return { ok: true, messages: result.messages, session: result.session, handedOff: result.handedOff, trace, vars: result.session?.vars ?? session.vars };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Simulation failed.", messages: [], session, handedOff: false, trace: [...trace, "Error: simulation stopped"], vars: session.vars };
  }
}
