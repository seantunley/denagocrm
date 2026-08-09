import type { Flow } from "./flow";

export type FlowVariable = {
  name: string;
  source: "built-in" | "captured" | "runtime";
  description: string;
};

const BUILT_INS: FlowVariable[] = [
  { name: "channel", source: "built-in", description: "whatsapp, messenger, instagram or telegram" },
  { name: "greeting", source: "built-in", description: "Personalised opening greeting" },
  { name: "first_name", source: "built-in", description: "Known customer's first name when available" },
  { name: "name", source: "built-in", description: "Known/captured customer name" },
  { name: "known", source: "built-in", description: "1 when the channel identity matched a known customer" },
  { name: "slot", source: "runtime", description: "Booked workshop slot label after a slot is reserved" },
];

export function flowVariableCatalog(flow: Flow): FlowVariable[] {
  const byName = new Map(BUILT_INS.map((item) => [item.name, item]));
  for (const node of Object.values(flow.nodes)) {
    if (node.type !== "capture" && node.type !== "captureFile") continue;
    if (!node.variable) continue;
    byName.set(node.variable, {
      name: node.variable,
      source: "captured",
      description: node.type === "captureFile"
        ? `File URL captured by “${node.text.slice(0, 48)}”`
        : `${node.format ?? "text"} captured by “${node.text.slice(0, 48)}”`,
    });
  }
  return [...byName.values()].sort((a, b) => {
    const rank = { "built-in": 0, captured: 1, runtime: 2 } as const;
    return rank[a.source] - rank[b.source] || a.name.localeCompare(b.name);
  });
}
