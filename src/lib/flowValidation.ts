import { choiceId, type Flow, type FlowNode, type FlowOption } from "./flow";

export type FlowChannel = "whatsapp" | "messenger" | "instagram" | "telegram";
export type FlowIssue = { severity: "error" | "warning"; code: string; message: string; nodeId?: string; channel?: FlowChannel };

const NODE_TYPES = new Set<FlowNode["type"]>([
  "message", "choice", "capture", "captureFile", "image", "answer", "set", "switch", "http", "knowledge", "extract", "delay", "subflow",
  "booking", "slots", "journey", "condition", "ai", "handoff", "end",
]);
const BUILTIN_VARS = new Set([
  "greeting", "first_name", "name", "known", "slot", "channel", "current_date", "current_time",
  "booking_identity", "booking_found", "booking_id", "booking_slot", "booking_summary", "booking_cancelled", "booking_rescheduled",
  "journey_started", "journey_reason", "journey_run_id",
]);
const AUTO_TYPES = new Set<FlowNode["type"]>(["message", "image", "answer", "set", "switch", "http", "knowledge", "extract", "subflow", "booking", "journey", "condition"]);
const CAN_FAIL = new Set<FlowNode["type"]>(["booking", "slots", "journey", "http", "knowledge", "extract", "subflow"]);
const str = (value: unknown): string => typeof value === "string" ? value : "";
const variableOk = (value: unknown): boolean => /^\w+$/.test(str(value));
const issue = (severity: FlowIssue["severity"], code: string, message: string, nodeId?: string, channel?: FlowChannel): FlowIssue => ({ severity, code, message, ...(nodeId ? { nodeId } : {}), ...(channel ? { channel } : {}) });

function optionsOf(node: unknown): FlowOption[] {
  if (!node || typeof node !== "object") return [];
  const options = (node as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.filter((option): option is FlowOption => Boolean(option) && typeof option === "object").map((option) => ({ id: str((option as { id?: unknown }).id), label: str((option as { label?: unknown }).label), description: str((option as { description?: unknown }).description) || undefined, next: str((option as { next?: unknown }).next) || undefined }));
}

function refs(node: FlowNode): string[] {
  if (node.type === "choice") return optionsOf(node).flatMap((option) => option.next ? [option.next] : []);
  if (node.type === "condition") return [node.trueNext, node.falseNext].filter((value): value is string => Boolean(str(value)));
  if (node.type === "switch") return [...node.cases.map((item) => item.next), node.defaultNext].filter((value): value is string => Boolean(str(value)));
  if (node.type === "ai") return node.handoffNext ? [node.handoffNext] : [];
  if (node.type === "handoff" || node.type === "end") return [];
  const routed = node as { next?: unknown; failureNext?: unknown; unavailableNext?: unknown };
  return [str(routed.next), str(routed.failureNext), str(routed.unavailableNext)].filter(Boolean);
}

function allText(node: FlowNode): string[] {
  const values: unknown[] = [];
  if (node.type === "message" || node.type === "handoff") values.push(node.text);
  if (node.type === "handoff") values.push(node.reason, node.summary);
  if (node.type === "choice" || node.type === "capture" || node.type === "captureFile" || node.type === "slots") values.push(node.text);
  if (node.type === "slots") values.push(node.noneText, node.failureText);
  if (node.type === "image") values.push(node.caption);
  if (node.type === "answer" || node.type === "booking" || node.type === "journey") values.push(node.text);
  if (node.type === "set") values.push(node.value);
  if (node.type === "http") values.push(node.url, node.headers, node.body, node.failureText);
  if (node.type === "knowledge") values.push(node.query, node.noMatchText);
  if (node.type === "extract") values.push(node.instruction, node.failureText);
  if (node.type === "subflow") values.push(node.failureText);
  return values.map(str).filter(Boolean);
}
const referencedVars = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]);

function reachable(flow: Flow): Set<string> {
  const seen = new Set<string>(); const stack = [flow.start];
  while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; const node = flow.nodes[id]; if (!node || typeof node !== "object") continue; seen.add(id); for (const target of refs(node as FlowNode)) stack.push(target); }
  return seen;
}

function automaticCycles(flow: Flow): string[][] {
  const visiting = new Set<string>(); const visited = new Set<string>(); const stack: string[] = []; const cycles: string[][] = []; const emitted = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) { const start = stack.indexOf(id); const cycle = stack.slice(start).concat(id); const key = [...new Set(cycle)].sort().join("|"); if (!emitted.has(key)) { emitted.add(key); cycles.push(cycle); } return; }
    if (visited.has(id)) return;
    const node = flow.nodes[id] as FlowNode | undefined; if (!node || !NODE_TYPES.has(node.type) || !AUTO_TYPES.has(node.type)) return;
    visiting.add(id); stack.push(id);
    for (const target of refs(node)) { const targetNode = flow.nodes[target] as FlowNode | undefined; if (targetNode && NODE_TYPES.has(targetNode.type) && AUTO_TYPES.has(targetNode.type)) visit(target); }
    stack.pop(); visiting.delete(id); visited.add(id);
  }
  for (const id of Object.keys(flow.nodes)) visit(id);
  return cycles;
}

const encodedBytes = (value: string) => new TextEncoder().encode(value).length;
function validateChoiceForChannel(nodeId: string, options: FlowOption[], channel: FlowChannel): FlowIssue[] {
  const out: FlowIssue[] = [];
  if (channel === "whatsapp") {
    if (options.length > 10) out.push(issue("error", "channel.whatsapp.options", "WhatsApp lists support at most 10 options; extra options would be silently dropped.", nodeId, channel));
    const buttonMode = options.length <= 3; const labelLimit = buttonMode ? 20 : 24; const idLimit = buttonMode ? 256 : 200;
    for (const option of options) { if (option.label.length > labelLimit) out.push(issue("error", "channel.whatsapp.label", `WhatsApp ${buttonMode ? "button" : "list"} labels must be ${labelLimit} characters or fewer.`, nodeId, channel)); if (choiceId(nodeId, option.id).length > idLimit) out.push(issue("error", "channel.whatsapp.choice_id", `This WhatsApp option id exceeds the ${idLimit}-character provider limit and would no longer match when tapped.`, nodeId, channel)); if (!buttonMode && (option.description?.length ?? 0) > 72) out.push(issue("error", "channel.whatsapp.description", "WhatsApp list descriptions must be 72 characters or fewer.", nodeId, channel)); }
  }
  if (channel === "messenger" || channel === "instagram") { const label = channel === "instagram" ? "Instagram" : "Messenger"; if (options.length > 11) out.push(issue("error", "channel.meta.options", `${label} quick replies support at most 11 options; extra options would be silently dropped.`, nodeId, channel)); for (const option of options) { if (option.label.length > 20) out.push(issue("error", "channel.meta.label", `${label} quick-reply labels must be 20 characters or fewer.`, nodeId, channel)); if (choiceId(nodeId, option.id).length > 1000) out.push(issue("error", "channel.meta.payload", "This quick-reply payload exceeds Meta's adapter limit.", nodeId, channel)); } }
  if (channel === "telegram") for (const option of options) if (encodedBytes(choiceId(nodeId, option.id)) > 64) out.push(issue("error", "channel.telegram.callback", "Telegram callback data is limited to 64 bytes; this option id would be truncated and stop matching.", nodeId, channel));
  return out;
}

function producedVariables(node: FlowNode): string[] {
  if (node.type === "capture" || node.type === "captureFile" || node.type === "set") return str(node.variable) ? [str(node.variable)] : [];
  if (node.type === "http" || node.type === "knowledge") return str(node.saveAs) ? [str(node.saveAs)] : [];
  if (node.type === "extract") return node.fields.map(str).filter(Boolean);
  return [];
}
export function flowVariables(flow: Flow): string[] { const vars = new Set(BUILTIN_VARS); for (const node of Object.values(flow.nodes)) for (const variable of producedVariables(node)) vars.add(variable); return [...vars].sort(); }

export function validateFlow(flow: Flow, channels: FlowChannel[] = ["whatsapp"]): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (!flow || typeof flow !== "object" || !flow.nodes || typeof flow.nodes !== "object") return [issue("error", "graph.shape", "Flow data is malformed.")];
  const entries = Object.entries(flow.nodes);
  if (!str(flow.start) || !flow.nodes[str(flow.start)]) return [issue("error", "graph.start", "Flow needs a valid start node.")];
  if (!entries.length) return [issue("error", "graph.empty", "Flow has no nodes.")];
  if (entries.length > 250) issues.push(issue("error", "graph.size", "Flow exceeds the 250-node safety limit."));
  const captured = new Set(BUILTIN_VARS);
  for (const [, raw] of entries) if (raw && typeof raw === "object" && NODE_TYPES.has(str((raw as { type?: unknown }).type) as FlowNode["type"])) for (const variable of producedVariables(raw as FlowNode)) if (variableOk(variable)) captured.add(variable);
  const hasBookingLookup = entries.some(([, node]) => node?.type === "booking" && node.action === "lookup");

  for (const [key, rawNode] of entries) {
    if (!rawNode || typeof rawNode !== "object") { issues.push(issue("error", "node.shape", `Node “${key}” is malformed.`, key)); continue; }
    const runtimeNode = rawNode as Record<string, unknown>; const id = str(runtimeNode.id); const type = str(runtimeNode.type);
    if (!id || !NODE_TYPES.has(type as FlowNode["type"])) { issues.push(issue("error", "node.shape", `Node “${key}” has an unsupported or malformed type.`, key)); continue; }
    const node = rawNode as FlowNode;
    if (id !== key) issues.push(issue("error", "node.id_mismatch", `Node key “${key}” does not match its id “${id}”.`, key));
    for (const variable of producedVariables(node)) if (!variableOk(variable)) issues.push(issue("error", "variable.invalid", "Variable names must contain only letters, numbers or underscores.", id));

    if (node.type === "choice") {
      const options = optionsOf(node); if (!Array.isArray(runtimeNode.options) || !options.length) issues.push(issue("error", "choice.empty", "Menu needs at least one valid option.", id));
      else { const ids = new Set<string>(); for (const option of options) { if (!option.id || ids.has(option.id)) issues.push(issue("error", "choice.option_id", "Menu option ids must be non-empty and unique within the node.", id)); ids.add(option.id); if (!option.label.trim()) issues.push(issue("error", "choice.label", "Every menu option needs a label.", id)); if (!option.next) issues.push(issue("warning", "choice.dead_end", `Option “${option.label || option.id}” ends the conversation without an explicit End node.`, id)); } for (const channel of channels) issues.push(...validateChoiceForChannel(id, options, channel)); }
    }
    if (node.type === "condition") { const variable = str(node.condition?.variable); const operator = str(node.condition?.operator); if (!variableOk(variable)) issues.push(issue("error", "condition.variable", "Condition needs a valid variable name.", id)); if (!["equals", "not_equals", "contains", "exists", "empty"].includes(operator)) issues.push(issue("error", "condition.operator", "Condition uses an unsupported operator.", id)); if (["equals", "not_equals", "contains"].includes(operator) && !str(node.condition?.value).trim()) issues.push(issue("warning", "condition.value", "This condition compares against an empty value.", id)); if (!node.trueNext) issues.push(issue("warning", "condition.true_dead_end", "Condition has no Yes/true destination.", id)); if (!node.falseNext) issues.push(issue("warning", "condition.false_dead_end", "Condition has no No/false destination.", id)); }
    if (node.type === "switch") { if (!variableOk(node.variable)) issues.push(issue("error", "switch.variable", "Switch needs a valid variable name.", id)); if (!Array.isArray(node.cases) || !node.cases.length) issues.push(issue("error", "switch.empty", "Switch needs at least one case.", id)); const ids = new Set<string>(); const values = new Set<string>(); for (const item of node.cases ?? []) { const value = str(item.value).trim().toLocaleLowerCase(); if (!item.id || ids.has(item.id)) issues.push(issue("error", "switch.case_id", "Switch case ids must be non-empty and unique.", id)); if (!value || values.has(value)) issues.push(issue("error", "switch.case_value", "Switch case values must be non-empty and unique.", id)); if (!item.next) issues.push(issue("warning", "switch.case_dead_end", `Switch case “${item.label || item.value || item.id}” has no destination.`, id)); ids.add(item.id); values.add(value); } if (!node.defaultNext) issues.push(issue("warning", "switch.default_dead_end", "Switch has no default destination.", id)); }
    if (node.type === "set" && !variableOk(node.variable)) issues.push(issue("error", "set.variable", "Set variable needs a valid variable name.", id));
    if (node.type === "http") { if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(node.method)) issues.push(issue("error", "http.method", "API request uses an unsupported method.", id)); if (!str(node.url).trim()) issues.push(issue("error", "http.url", "API request needs an HTTPS URL.", id)); else if (!str(node.url).includes("{{") && !/^https:\/\//i.test(str(node.url))) issues.push(issue("error", "http.https", "API requests must use HTTPS.", id)); if (node.headers?.trim()) { try { const parsed = JSON.parse(node.headers); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); } catch { issues.push(issue("error", "http.headers", "API headers must be a JSON object.", id)); } } }
    if (node.type === "extract") { if (!node.instruction.trim()) issues.push(issue("error", "extract.instruction", "AI extract needs an instruction.", id)); if (!Array.isArray(node.fields) || !node.fields.length || node.fields.length > 12) issues.push(issue("error", "extract.fields", "AI extract needs 1–12 output fields.", id)); const unique = new Set<string>(); for (const field of node.fields ?? []) { if (!variableOk(field) || unique.has(field)) issues.push(issue("error", "extract.field", "AI extract fields must be unique valid variable names.", id)); unique.add(field); } if (node.sourceVariable && !variableOk(node.sourceVariable)) issues.push(issue("error", "extract.source", "AI extract source variable is invalid.", id)); }
    if (node.type === "delay" && (!Number.isFinite(node.seconds) || node.seconds < 1 || node.seconds > 604800)) issues.push(issue("error", "delay.range", "Wait must be between 1 second and 7 days.", id));
    if (node.type === "subflow" && !str(node.flowId).trim()) issues.push(issue("error", "subflow.missing", "Run subflow needs a published flow selected.", id));
    if (node.type === "answer" && !node.answerSource && !str(node.text).trim()) issues.push(issue("warning", "answer.empty", "Answer node has no text or dynamic answer source.", id));
    if (node.type === "image") { const url = str(node.url); if (!url.trim()) issues.push(issue("error", "image.missing", "Image node has no image URL.", id)); if (/\.private\.blob\.vercel-storage\.com/i.test(url)) issues.push(issue("error", "image.private_url", "Messaging providers cannot fetch a private Blob URL directly. Upload/provider media handling is required for this image.", id)); }
    if (node.type === "booking" && node.action && !["service", "demo", "lead", "lookup", "cancel"].includes(str(node.action))) issues.push(issue("error", "booking.action", "CRM action is not supported by the runtime.", id));
    if (node.type === "booking" && node.action === "cancel" && !hasBookingLookup) issues.push(issue("warning", "booking.lookup_missing", "Cancel booking normally needs a CRM lookup node first so {{booking_id}} belongs to this customer.", id));
    if (node.type === "slots" && node.action && !["book", "reschedule"].includes(str(node.action))) issues.push(issue("error", "slots.action", "Slot action must book a new appointment or reschedule an existing booking.", id));
    if (node.type === "slots" && node.action === "reschedule" && !hasBookingLookup) issues.push(issue("warning", "booking.lookup_missing", "Reschedule normally needs a CRM lookup node first so the existing customer-owned booking is known.", id));
    if (node.type === "journey" && !str(node.journeyId).trim()) issues.push(issue("error", "journey.missing", "Start Journey needs a Journey selected.", id));
    for (const target of refs(node)) if (!flow.nodes[target]) issues.push(issue("error", "graph.missing_target", `Connection points to missing node “${target}”.`, id));
  }

  const live = reachable(flow); for (const [id] of entries) if (!live.has(id)) issues.push(issue("warning", "graph.unreachable", "Node is not reachable from the start node.", id));
  for (const cycle of automaticCycles(flow)) issues.push(issue("error", "graph.automatic_cycle", `Automatic loop detected: ${cycle.join(" → ")}. It would run until the engine guard stops it.`, cycle[0]));
  for (const [, rawNode] of entries) {
    if (!rawNode || typeof rawNode !== "object" || !NODE_TYPES.has(str((rawNode as { type?: unknown }).type) as FlowNode["type"])) continue;
    const node = rawNode as FlowNode;
    for (const text of allText(node)) for (const variable of referencedVars(text)) if (!captured.has(variable)) issues.push(issue("warning", "variable.unknown", `Message references {{${variable}}}, but no capture, Set variable, extraction or built-in variable defines it.`, node.id));
    if (CAN_FAIL.has(node.type) && !str((node as { failureNext?: unknown }).failureNext)) { const onwards = str((node as { next?: unknown }).next); const announces = onwards ? allText(flow.nodes[onwards] ?? ({} as FlowNode)).join(" ") : ""; if (onwards && announces.trim()) issues.push(issue("warning", "action.no_failure_branch", "This action can fail, but its failure has no explicit recovery route before customer-facing output.", node.id)); }
  }
  return issues;
}

export function publishSeverity(issues: FlowIssue[]): FlowIssue[] { const blocking = new Set(["action.no_failure_branch"]); return issues.map((entry) => blocking.has(entry.code) ? { ...entry, severity: "error" } : entry); }
export const flowErrors = (issues: FlowIssue[]) => issues.filter((entry) => entry.severity === "error");
