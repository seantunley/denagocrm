import { choiceId, type Flow, type FlowNode, type FlowOption } from "./flow";

export type FlowChannel = "whatsapp" | "messenger" | "instagram" | "telegram";
export type FlowIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  channel?: FlowChannel;
};

const NODE_TYPES = new Set([
  "message", "choice", "capture", "captureFile", "image", "answer",
  "booking", "slots", "ai", "handoff", "end",
]);
const BUILTIN_VARS = new Set(["greeting", "first_name", "name", "known", "slot"]);
const AUTO_TYPES = new Set<FlowNode["type"]>(["message", "image", "answer", "booking"]);

function issue(
  severity: FlowIssue["severity"],
  code: string,
  message: string,
  nodeId?: string,
  channel?: FlowChannel,
): FlowIssue {
  return { severity, code, message, ...(nodeId ? { nodeId } : {}), ...(channel ? { channel } : {}) };
}

const str = (value: unknown): string => typeof value === "string" ? value : "";

function optionsOf(node: unknown): FlowOption[] {
  if (!node || typeof node !== "object") return [];
  const options = (node as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.filter((option): option is FlowOption => Boolean(option) && typeof option === "object")
    .map((option) => ({
      id: str((option as { id?: unknown }).id),
      label: str((option as { label?: unknown }).label),
      description: str((option as { description?: unknown }).description) || undefined,
      next: str((option as { next?: unknown }).next) || undefined,
    }));
}

function refs(node: FlowNode): string[] {
  if (node.type === "choice") return optionsOf(node).flatMap((option) => option.next ? [option.next] : []);
  if (node.type === "ai") return str(node.handoffNext) ? [str(node.handoffNext)] : [];
  if (node.type === "handoff" || node.type === "end") return [];
  const next = str((node as { next?: unknown }).next);
  return next ? [next] : [];
}

function allText(node: FlowNode): string[] {
  const values: unknown[] = [];
  if (node.type === "message" || node.type === "handoff") values.push(node.text);
  if (node.type === "choice" || node.type === "capture" || node.type === "captureFile" || node.type === "slots") values.push(node.text);
  if (node.type === "slots") values.push(node.noneText);
  if (node.type === "image") values.push(node.caption);
  if (node.type === "answer" || node.type === "booking") values.push(node.text);
  return values.map(str).filter(Boolean);
}

function referencedVars(text: string): string[] {
  return [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]);
}

function reachable(flow: Flow): Set<string> {
  const seen = new Set<string>();
  const stack = [flow.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const node = flow.nodes[id];
    if (!node || typeof node !== "object") continue;
    seen.add(id);
    for (const target of refs(node as FlowNode)) stack.push(target);
  }
  return seen;
}

/** Detect a cycle made only of nodes the engine walks without customer input. */
function automaticCycles(flow: Flow): string[][] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const emitted = new Set<string>();

  function visit(id: string) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start).concat(id);
      const key = [...new Set(cycle)].sort().join("|");
      if (!emitted.has(key)) { emitted.add(key); cycles.push(cycle); }
      return;
    }
    if (visited.has(id)) return;
    const node = flow.nodes[id] as FlowNode | undefined;
    if (!node || !NODE_TYPES.has(node.type) || !AUTO_TYPES.has(node.type)) return;
    visiting.add(id);
    stack.push(id);
    for (const target of refs(node)) {
      const targetNode = flow.nodes[target] as FlowNode | undefined;
      if (targetNode && NODE_TYPES.has(targetNode.type) && AUTO_TYPES.has(targetNode.type)) visit(target);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of Object.keys(flow.nodes)) visit(id);
  return cycles;
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateChoiceForChannel(
  nodeId: string,
  options: FlowOption[],
  channel: FlowChannel,
): FlowIssue[] {
  const out: FlowIssue[] = [];
  if (channel === "whatsapp") {
    if (options.length > 10) {
      out.push(issue("error", "channel.whatsapp.options", "WhatsApp lists support at most 10 options; extra options would be silently dropped.", nodeId, channel));
    }
    const buttonMode = options.length <= 3;
    const labelLimit = buttonMode ? 20 : 24;
    const idLimit = buttonMode ? 256 : 200;
    for (const option of options) {
      if (option.label.length > labelLimit) {
        out.push(issue("error", "channel.whatsapp.label", `WhatsApp ${buttonMode ? "button" : "list"} labels must be ${labelLimit} characters or fewer.`, nodeId, channel));
      }
      if (choiceId(nodeId, option.id).length > idLimit) {
        out.push(issue("error", "channel.whatsapp.choice_id", `This WhatsApp option id exceeds the ${idLimit}-character provider limit and would no longer match when tapped.`, nodeId, channel));
      }
      if (!buttonMode && (option.description?.length ?? 0) > 72) {
        out.push(issue("error", "channel.whatsapp.description", "WhatsApp list descriptions must be 72 characters or fewer.", nodeId, channel));
      }
    }
  }

  if (channel === "messenger" || channel === "instagram") {
    const label = channel === "instagram" ? "Instagram" : "Messenger";
    if (options.length > 11) {
      out.push(issue("error", "channel.meta.options", `${label} quick replies support at most 11 options; extra options would be silently dropped.`, nodeId, channel));
    }
    for (const option of options) {
      if (option.label.length > 20) out.push(issue("error", "channel.meta.label", `${label} quick-reply labels must be 20 characters or fewer.`, nodeId, channel));
      if (choiceId(nodeId, option.id).length > 1000) out.push(issue("error", "channel.meta.payload", "This quick-reply payload exceeds Meta's adapter limit.", nodeId, channel));
    }
  }

  if (channel === "telegram") {
    for (const option of options) {
      if (encodedBytes(choiceId(nodeId, option.id)) > 64) {
        out.push(issue("error", "channel.telegram.callback", "Telegram callback data is limited to 64 bytes; this option id would be truncated and stop matching.", nodeId, channel));
      }
    }
  }
  return out;
}

/**
 * Pure graph compiler/linter. Drafts may contain issues; publication must reject
 * every error. Warnings are actionable but do not make execution unsafe.
 */
export function validateFlow(flow: Flow, channels: FlowChannel[] = ["whatsapp"]): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (!flow || typeof flow !== "object" || !flow.nodes || typeof flow.nodes !== "object") {
    return [issue("error", "graph.shape", "Flow data is malformed.")];
  }
  const entries = Object.entries(flow.nodes);
  if (!str(flow.start) || !flow.nodes[str(flow.start)]) return [issue("error", "graph.start", "Flow needs a valid start node.")];
  if (!entries.length) return [issue("error", "graph.empty", "Flow has no nodes.")];
  if (entries.length > 250) issues.push(issue("error", "graph.size", "Flow exceeds the 250-node safety limit."));

  const captured = new Set(BUILTIN_VARS);
  for (const [key, rawNode] of entries) {
    if (!rawNode || typeof rawNode !== "object") {
      issues.push(issue("error", "node.shape", `Node “${key}” is malformed.`, key));
      continue;
    }
    const runtimeNode = rawNode as Record<string, unknown>;
    const id = str(runtimeNode.id);
    const type = str(runtimeNode.type);
    if (!id || !NODE_TYPES.has(type)) {
      issues.push(issue("error", "node.shape", `Node “${key}” has an unsupported or malformed type.`, key));
      continue;
    }
    const node = rawNode as FlowNode;
    if (id !== key) issues.push(issue("error", "node.id_mismatch", `Node key “${key}” does not match its id “${id}”.`, key));

    if (node.type === "capture" || node.type === "captureFile") {
      const variable = str(node.variable);
      if (!variable || !/^\w+$/.test(variable)) {
        issues.push(issue("error", "variable.invalid", "Captured variable names must contain only letters, numbers or underscores.", id));
      } else {
        if (captured.has(variable) && !BUILTIN_VARS.has(variable)) issues.push(issue("warning", "variable.reused", `Variable {{${variable}}} is captured more than once.`, id));
        captured.add(variable);
      }
    }

    if (node.type === "choice") {
      const rawOptions = runtimeNode.options;
      const options = optionsOf(node);
      if (!Array.isArray(rawOptions) || !options.length) {
        issues.push(issue("error", "choice.empty", "Menu needs at least one valid option.", id));
      } else {
        const ids = new Set<string>();
        for (const option of options) {
          if (!option.id || ids.has(option.id)) issues.push(issue("error", "choice.option_id", "Menu option ids must be non-empty and unique within the node.", id));
          ids.add(option.id);
          if (!option.label.trim()) issues.push(issue("error", "choice.label", "Every menu option needs a label.", id));
          if (!option.next) issues.push(issue("warning", "choice.dead_end", `Option “${option.label || option.id}” ends the conversation without an explicit End node.`, id));
        }
        for (const channel of channels) issues.push(...validateChoiceForChannel(id, options, channel));
      }
    }

    if (node.type === "answer" && !node.answerSource && !str(node.text).trim()) issues.push(issue("warning", "answer.empty", "Answer node has no text or dynamic answer source.", id));
    if (node.type === "image") {
      const url = str(node.url);
      if (!url.trim()) issues.push(issue("error", "image.missing", "Image node has no image URL.", id));
      if (/\.private\.blob\.vercel-storage\.com/i.test(url)) issues.push(issue("error", "image.private_url", "Messaging providers cannot fetch a private Blob URL directly. Upload/provider media handling is required for this image.", id));
    }
    if (node.type === "booking" && node.action && !["service", "demo", "lead"].includes(str(node.action))) issues.push(issue("error", "booking.action", "CRM action is not supported by the runtime.", id));

    for (const target of refs(node)) {
      if (!flow.nodes[target]) issues.push(issue("error", "graph.missing_target", `Connection points to missing node “${target}”.`, id));
    }

    if (node.type === "captureFile") {
      for (const channel of channels) {
        if (channel !== "whatsapp") {
          const label = channel === "instagram" ? "Instagram" : channel === "messenger" ? "Messenger" : "Telegram";
          issues.push(issue("error", "channel.file_capture", `File capture is not implemented for ${label}; this flow would pause forever on that channel.`, id, channel));
        }
      }
    }
  }

  const live = reachable(flow);
  for (const [id] of entries) if (!live.has(id)) issues.push(issue("warning", "graph.unreachable", "Node is not reachable from the start node.", id));
  for (const cycle of automaticCycles(flow)) issues.push(issue("error", "graph.automatic_cycle", `Automatic loop detected: ${cycle.join(" → ")}. It would run until the engine guard stops it.`, cycle[0]));

  for (const [, rawNode] of entries) {
    if (!rawNode || typeof rawNode !== "object" || !NODE_TYPES.has(str((rawNode as { type?: unknown }).type))) continue;
    const node = rawNode as FlowNode;
    for (const text of allText(node)) {
      for (const variable of referencedVars(text)) {
        if (!captured.has(variable)) issues.push(issue("warning", "variable.unknown", `Message references {{${variable}}}, but no capture or built-in variable defines it.`, str(node.id)));
      }
    }
  }
  return issues;
}

export const flowErrors = (issues: FlowIssue[]): FlowIssue[] => issues.filter((item) => item.severity === "error");
export const flowWarnings = (issues: FlowIssue[]): FlowIssue[] => issues.filter((item) => item.severity === "warning");
