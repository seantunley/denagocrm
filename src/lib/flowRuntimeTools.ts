import "server-only";

import { lookup } from "node:dns/promises";
import { lookup as lookupCb } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { recordAiUsage } from "./systemHealth";
import { runtimeFlowTenantId } from "./flowScope";
import { renderKnowledgeForPrompt, searchBotKnowledge } from "./botKnowledge";
import type { ExtractOutcome, Flow, FlowCtx, HttpOutcome, KnowledgeOutcome } from "./flow";

const MAX_HTTP_RESPONSE_BYTES = 50_000;
const MAX_HTTP_BODY_BYTES = 20_000;
const MAX_EXTRACT_TEXT = 6_000;
const MAX_EXTRACT_INSTRUCTION = 1_000;
const BLOCKED_HEADERS = new Set(["host", "connection", "cookie", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate"]);

function parsePublishedFlow(definition: string): Flow | null {
  try {
    const parsed = JSON.parse(definition);
    return parsed?.start && parsed?.nodes?.[parsed.start] ? parsed as Flow : null;
  } catch {
    return null;
  }
}

function strictObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function privateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function privateIpv6(ip: string): boolean {
  const value = ip.toLowerCase();
  return value === "::" || value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff");
}

function unsafeIp(ip: string): boolean {
  const family = isIP(ip);
  return family === 4 ? privateIpv4(ip) : family === 6 ? privateIpv6(ip) : true;
}

async function safeHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("API URL is invalid"); }
  if (url.protocol !== "https:") throw new Error("API requests must use HTTPS");
  if (url.username || url.password) throw new Error("API URL credentials are not allowed");
  if (url.hash) throw new Error("API URL fragments are not allowed");
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("API URL host is not allowed");
  if (isIP(host)) {
    if (unsafeIp(host)) throw new Error("API URL resolves to a private or reserved address");
    return url;
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => unsafeIp(address))) throw new Error("API URL resolves to a private or reserved address");
  return url;
}

/**
 * THE CHECK ABOVE ALONE IS NOT ENOUGH — fetch resolves DNS again.
 *
 * `safeHttpsUrl` validates the addresses IT resolved, but `fetch` performs its
 * own, independent resolution when it connects. A hostname the flow author (or
 * whoever their URL points at) controls, published with a short TTL, can answer
 * with a public address for the check and 169.254.169.254 for the connect —
 * classic DNS rebinding, and the guard never fires.
 *
 * So the same `unsafeIp` test runs a second time HERE, inside the dispatcher's
 * connect-time lookup — on the exact address the socket is about to open to.
 * There is no gap left between check and use, because the check has become part
 * of the use.
 */
const guardedDispatcher = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      lookupCb(hostname, options, (err, address, family) => {
        if (err) return callback(err, address, family);
        const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
        if (addresses.some((ip) => unsafeIp(String(ip)))) {
          return callback(Object.assign(new Error("API URL resolves to a private or reserved address"), { code: "EBLOCKED" }), address, family);
        }
        callback(null, address, family);
      });
    },
  },
});

function requestHeaders(raw?: string): Headers {
  const headers = new Headers();
  if (!raw?.trim()) return headers;
  const parsed = strictObject(raw);
  if (!parsed) throw new Error("API headers must be a JSON object");
  for (const [key, value] of Object.entries(parsed)) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || BLOCKED_HEADERS.has(normalized)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") headers.set(key, String(value));
  }
  return headers;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("API response exceeded the 50 KB Flowbot limit");
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}

async function knowledgeAnswer(query: string): Promise<KnowledgeOutcome> {
  const entries = await searchBotKnowledge(query, new Date(), 3);
  if (!entries.length) return { ok: false, unavailable: true, reason: "No approved knowledge matched" };
  const text = renderKnowledgeForPrompt(entries, 4_000);
  return text ? { ok: true, text } : { ok: false, unavailable: true, reason: "No approved knowledge content matched" };
}

async function extractData(input: Parameters<NonNullable<FlowCtx["extractData"]>>[0]): Promise<ExtractOutcome> {
  const fields = [...new Set(input.fields.map((field) => field.trim()).filter(Boolean))].slice(0, 12);
  if (!fields.length) return { ok: false, reason: "No extraction fields were configured" };
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return { ok: false, reason: "AI extraction is not configured" };
  const source = input.text.trim().slice(0, MAX_EXTRACT_TEXT);
  if (!source) return { ok: false, unavailable: true, reason: "There is no text to extract from" };
  const instruction = input.instruction.trim().slice(0, MAX_EXTRACT_INSTRUCTION);
  const fieldList = fields.join(", ");
  const system = `Extract structured values from the supplied customer text. Return exactly one JSON object and nothing else. Allowed keys: ${fieldList}.\nRules:\n- Never invent a value.\n- Omit a key when the text does not support it.\n- Every returned value must be a string.\n- Do not return keys outside the allowed list.\n${instruction ? `Task: ${instruction}` : ""}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 350, system, messages: [{ role: "user", content: source }] }),
    });
    if (!res.ok) {
      await logError("flow-ai-extract", `Anthropic ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return { ok: false, reason: `AI extraction provider returned ${res.status}` };
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const parsed = strictObject(String(json.content?.[0]?.text ?? ""));
    if (!parsed) return { ok: false, reason: "AI extraction returned invalid structured data" };
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim()) values[field] = value.trim().slice(0, 2_000);
    }
    return Object.keys(values).length ? { ok: true, values } : { ok: false, unavailable: true, reason: "No requested values were present" };
  } catch (error) {
    await logError("flow-ai-extract", error).catch(() => {});
    return { ok: false, reason: error instanceof Error ? error.message : "AI extraction failed" };
  }
}

async function httpRequest(input: Parameters<NonNullable<FlowCtx["httpRequest"]>>[0]): Promise<HttpOutcome> {
  try {
    const url = await safeHttpsUrl(input.url);
    const headers = requestHeaders(input.headers);
    const body = input.method === "GET" || input.method === "DELETE" ? undefined : input.body ?? "";
    if (body && new TextEncoder().encode(body).byteLength > MAX_HTTP_BODY_BYTES) return { ok: false, reason: "API request body exceeds the 20 KB Flowbot limit" };
    if (body && !headers.has("content-type")) headers.set("content-type", "application/json");
    // `dispatcher` pins the connection to a connect-time re-check of the resolved
    // address (see guardedDispatcher) — without it this fetch re-resolves DNS on
    // its own and the safeHttpsUrl check can be rebound around.
    const response = await fetch(url, { method: input.method, headers, body, signal: AbortSignal.timeout(10_000), redirect: "error", dispatcher: guardedDispatcher } as RequestInit & { dispatcher: Agent });
    const responseBody = await boundedText(response);
    return response.ok ? { ok: true, status: response.status, body: responseBody } : { ok: false, status: response.status, body: responseBody, reason: `API returned ${response.status}` };
  } catch (error) {
    await logError("flow-http-request", error).catch(() => {});
    return { ok: false, reason: error instanceof Error ? error.message : "API request failed" };
  }
}

async function loadSubflow(flowId: string): Promise<Flow | null> {
  const tenantId = runtimeFlowTenantId();
  const version = await prisma.botFlowVersion.findFirst({ where: { tenantId, flowId }, orderBy: { version: "desc" }, select: { definition: true } });
  return version ? parsePublishedFlow(version.definition) : null;
}

export function flowRuntimeTools(): Pick<FlowCtx, "knowledgeAnswer" | "extractData" | "httpRequest" | "loadSubflow"> {
  return {
    knowledgeAnswer: async (query) => knowledgeAnswer(query),
    extractData,
    httpRequest,
    loadSubflow,
  };
}
