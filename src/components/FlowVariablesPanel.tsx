import { Braces } from "lucide-react";
import type { FlowVariable } from "@/lib/flowVariables";

const sourceLabel: Record<FlowVariable["source"], string> = {
  "built-in": "Built-in",
  captured: "Captured",
  runtime: "Runtime",
};

export default function FlowVariablesPanel({ variables }: { variables: FlowVariable[] }) {
  return (
    <details className="rounded-xl border border-white/10 bg-white/[0.025]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <Braces className="size-4 text-cyan-300" />
        <span className="text-sm font-medium text-white">Variables</span>
        <span className="ml-auto text-xs text-slate-500">Use as {"{{variable}}"}</span>
      </summary>
      <div className="grid gap-2 border-t border-white/8 p-3 md:grid-cols-2 xl:grid-cols-3">
        {variables.map((variable) => (
          <div key={variable.name} className="rounded-lg border border-white/8 bg-black/10 px-3 py-2">
            <div className="flex items-center justify-between gap-2"><code className="text-xs text-orange-300">{`{{${variable.name}}}`}</code><span className="text-[10px] uppercase tracking-wide text-slate-500">{sourceLabel[variable.source]}</span></div>
            <p className="mt-1 text-xs leading-5 text-slate-400">{variable.description}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
