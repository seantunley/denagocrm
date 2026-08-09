import { choiceId, type Flow, type FlowNode } from "./flow";

export type FlowChannel = "whatsapp" | "messenger" | "instagram" | "telegram";
export type FlowIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  channel?: FlowChannel;
};

const NODE_TYPES = new Set([
  "message",
  "choice",
  "capture",
  "captureFile",
  "image",
  "answer",
  "booking",
  "slots",
  "ai",
  "handoff",
  "end",
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

function refs(node: FlowNode): string[] {
  if (node.type === "choice") return node.options.flatMap((option) => option.next ? [option.next] : []);
  if (node.type === "ai") return node.handoffNext ? [node.handoffNext] : [];
  if (node.type === "handoff" || node.type === "end") return [];
  const next = (node as { next?: string }).next;
  return next ? [next] : [];
}

function allText(node: FlowNode): string[] {
  if (node.type === "message" || node.type === "handoff") return node.text ? [node.text] : [];
  if (node.type === "choice" || node.type === "capture" || node.type === "captureFile" || node.type === "slots") {
    return [node.text, ...(node.type === "slots" && node.noneText ? [node.noneText] : [])];
  }
  if (node.type === "image") return node.caption ? [node.caption] : [];
  if (node.type === "answer") return node.text ? [node.text] : [];
  if (node.type === "booking") return node.text ? [node.text] : [];
  return [];
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
    if (!node) continue;
    seen.add(id);
    for (const target of refs(node)) stack.push(target);
  }
  return seen;
}

/** Detect a cycle consisting only of nodes the engine walks without user input. */
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
      if (!emitted.has(key)) {
        emitted.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(id)) return;
    const node = flow.nodes[id];
    if (!node || !AUTO_TYPES.has(node.type)) return;
    visiting.add(id);
    stack.push(id);
    for (const target of refs(node)) {
      const targetNode = flow.nodes[target];
      if (targetNode && AUTO_TYPES.has(targetNode.type)) visit(target);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of Object.keys(flow.nodes)) visit(id);
  return cycles;
}

function validateChoiceForChannel(
  node: Extract<FlowNode, { type: "choice" }>,
  channel: FlowChannel,
): FlowIssue[] {
  const out: FlowIssue[] = [];
  if (channel === "whatsapp") {
    if (node.options.length > 10) {
      out.push(issue("error", "channel.whatsapp.options", "WhatsApp lists support at most 10 options; extra options would be silently dropped.", node.id, channel));
    }
    const buttonMode = node.options.length <= 3;
    const labelLimit = buttonMode ? 20 : 24;
    const idLimit = buttonMode ? 256 : 200;
    for (const option of node.options) {
      if (option.label.length > labelLimit) {
        out.push(issue("error", "channel.whatsapp.label", `WhatsApp ${buttonMode ? "button" : "list"} labels must be ${labelLimit} characters or fewer.`, node.id, channel));
      }
      if (choiceId(node.id, option.id).length > idLimit) {
        out.push(issue("error", "channel.whatsapp.choice_id", `This WhatsApp option id exceeds the ${idLimit}-character provider limit and would no longer match when tapped.`, node.id, channel));
      }
      if (!buttonMode && (option.description?.length ?? 0) > 72) {
        out.push(issue("error", "channel.whatsapp.description", "WhatsApp list descriptions must be 72 characters or fewer.", node.id, channel));
      }
    }
  }

  if (channel === "messenger" || channel === "instagram") {
    if (node.options.length > 11) {
      out.push(issue("error", "channel.meta.options", `${channel === "instagram" ? "Instagram" : "Messenger"} quick replies support at most 11 options; extra options would be silently dropped.`, node.id, channel));
    }
    for (const option of node.options) {
      if (option.label.length > 20) {
        out.push(issue("error", "channel.meta.label", `${channel === "instagram" ? "Instagram" : "Messenger"} quick-reply labels must be 20 characters or fewer.`, node.id, channel));
      }
      if (choiceId(node.id, option.id).length > 1000) {
        out.push(issue("error", "channel.meta.payload", "This quick-reply payload exceeds Meta's adapter limit.", node.id, channel));
      }
    }
  }

  if (channel === "telegram") {
    for (const option of node.options) {
      if (Buffer.byteLength(choiceId(node.id, option.id), "utf8") > 64) {
        out.push(issue("error", "channel.telegram.callback", "Telegram callback data is limited to 64 bytes; this option id would be truncated and stop matching.", node.id, channel));
      }
    }
  }
  return out;
}

/**
 * Pure graph compiler/linter. Drafts may contain issues; publication must reject
 * any `error`. Warnings are actionable but do not make a graph unsafe to run.
 */
export function validateFlow(flow: Flow, channels: FlowChannel[] = ["whatsapp"]): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const entries = Object.entries(flow.nodes ?? {});

  if (!flow.start || !flow.nodes?.[flow.start]) {
    issues.push(issue("error", "graph.start", "Flow needs a valid start node."));
    return issues;
  }
  if (entries.length === 0) {
    issues.push(issue("error", "graph.empty", "Flow has no nodes."));
    return issues;
  }
  if (entries.length > 250) {
    issues.push(issue("error", "graph.size", "Flow exceeds the 250-node safety limit."));
  }

  const captured = new Set(BUILTIN_VARS);
  for (const [key, rawNode] of entries) {
    const node = rawNode as FlowNode;
    if (!node || typeof node !== "object" || typeof node.id !== "string" || !NODE_TYPES.has(node.type)) {
      issues.push(issue("error", "node.shape", `Node “${key}” has an unsupported or malformed type.`, key));
      continue;
    }
    if (node.id !== key) {
      issues.push(issue("error", "node.id_mismatch", `Node key “${key}” does not match its id “${node.id}”.`, key));
    }

    if (node.type === "capture" || node.type === "captureFile") {
      if (!node.variable || !/^\w+$/.test(node.variable)) {
        issues.push(issue("error", "variable.invalid", "Captured variable names must contain only letters, numbers or underscores.", node.id));
      } else {
        if (captured.has(node.variable) && !BUILTIN_VARS.has(node.variable)) {
          issues.push(issue("warning", "variable.reused", `Variable {{${node.variable}}} is captured more than once.`, node.id));
        }
        captured.add(node.variable);
      }
    }

    if (node.type === "choice") {
      if (!Array.isArray(node.options) || node.options.length === 0) {
        issues.push(issue("error", "choice.empty", "Menu needs at least one option.", node.id));
      } else {
        const ids = new Set<string>();
        for (const option of node.options) {
          if (!option.id || ids.has(option.id)) {
            issues.push(issue("error", "choice.option_id", "Menu option ids must be non-empty and unique within the node.", node.id));
          }
          ids.add(option.id);
          if (!option.label?.trim()) issues.push(issue("error", "choice.label", "Every menu option needs a label.", node.id));
          if (!option.next) issues.push(issue("warning", "choice.dead_end", `Option “${option.label || option.id}” ends the conversation without an explicit End node.`, node.id));
        }
      }
      for (const channel of channels) issues.push(...validateChoiceForChannel(node, channel));
    }

    if (node.type === "answer" && !node.answerSource && !node.text?.trim()) {
      issues.push(issue("warning", "answer.empty", "Answer node has no text or dynamic answer source.", node.id));
    }
    if (node.type === "image") {
      if (!node.url?.trim()) issues.push(issue("error", "image.missing", "Image node has no image URL.", node.id));
      if (/\.private\.blob\.vercel-storage\.com/i.test(node.url ?? "")) {
        issues.push(issue("error", "image.private_url", "Messaging providers cannot fetch a private Blob URL directly. Upload/provider media handling is required for this image.", node.id));
      }
    }
    if (node.type === "booking" && node.action && !["service", "demo", "lead"].includes(node.action)) {
      issues.push(issue("error", "booking.action", "CRM action is not supported by the runtime.", node.id));
    }

    for (const target of refs(node)) {
      if (!flow.nodes[target]) {
        issues.push(issue("error", "graph.missing_target", `Connection points to missing node “${target}”.`, node.id));
      }
    }

    if (node.type === "captureFile") {
      for (const channel of channels) {
        if (channel !== "whatsapp") {
          issues.push(issue("error", "channel.file_capture", `File capture is not implemented for ${channel === "instagram" ? "Instagram" : channel === "messenger" ? "Messenger" : "Telegram"}; this flow would pause forever on that channel.`, node.id, channel));
        }
      }
    }
  }

  const live = reachable(flow);
  for (const [id] of entries) {
    if (!live.has(id)) issues.push(issue("warning", "graph.unreachable", "Node is not reachable from the start node.", id));
  }
  for (const cycle of automaticCycles(flow)) {
    issues.push(issue("error", "graph.automatic_cycle", `Automatic loop detected: ${cycle.join(" → ")}. It would run until the engine guard stops it.`, cycle[0]));
  }

  // Variable references are linted after collecting every capture so ordering in
  // the serialized record cannot create false "unknown variable" warnings.
  for (const [, node] of entries) {
    if (!node || typeof node !== "object" || typeof (node as FlowNode).type !== "string") continue;
    for (const text of allText(node as FlowNode)) {
      for (const variable of referencedVars(text)) {
        if (!captured.has(variable)) {
          issues.push(issue("warning", "variable.unknown", `Message references {{${variable}}}, but no capture or built-in variable defines it.`, (node as FlowNode).id));
        }
      }
    }
  }

  return issues;
}

export function flowErrors(issues: FlowIssue[]): FlowIssue[] {
  return issues.filter((item) => item.severity === "error");
}

export function flowWarnings(issues: FlowIssue[]): FlowIssue[] {
  return issues.filter((item) => item.severity === "warning");
}
