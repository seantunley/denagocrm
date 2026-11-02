/**
 * CONNECTIONS FOR "API REQUEST" STEPS (Node-RED's config nodes; review 2026-11-02, Sean's item 2).
 *
 * An API request step used to carry its headers — an API key included — in the flow itself: readable by anyone who
 * can edit flows, and copied into every published version. A connection holds those secret headers once per
 * workspace, ENCRYPTED, and a step points at it by id. Each connection is locked to ONE host, so editing a flow can't
 * send the key anywhere else. Pure here; flowConnectionsServer.ts decrypts at send time.
 */

export const FLOW_CONNECTIONS_KEY = "FLOW_CONNECTIONS";
/** `value` is ciphertext (settings.encryptValue) — never shown back, never logged. */
export type FlowConnection = { id: string; name: string; host: string; headers: { name: string; value: string }[] };

const HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const HEADER = /^[A-Za-z0-9-]{1,60}$/;

/** The saved list — anything malformed dropped, never thrown on. */
export function parseConnections(raw: string | null | undefined): FlowConnection[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && typeof c.id === "string" && typeof c.name === "string" && typeof c.host === "string" && HOST.test(c.host) && Array.isArray(c.headers))
      .map((c) => ({
        id: c.id,
        name: c.name.slice(0, 60),
        host: c.host,
        headers: c.headers.filter((h: { name?: unknown; value?: unknown }) => typeof h?.name === "string" && HEADER.test(h.name) && typeof h.value === "string"),
      }))
      .slice(0, 50);
  } catch {
    return [];
  }
}

/** "api.sage.com", from what an owner types — a URL or a bare host; null when it isn't one. */
export function connectionHost(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  try {
    const host = new URL(text.includes("://") ? text : `https://${text}`).hostname;
    return HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** A request may use a connection only on that connection's own host. */
export function connectionAllows(connection: Pick<FlowConnection, "host">, url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === connection.host;
  } catch {
    return false;
  }
}

const SECRET_NAME = /authorization|api[-_ ]?key|token|secret|password|passwd|bearer|signature|session/i;

/** Header names in a step's own JSON that look like a credential — a reason to move them into a connection. */
export function secretLookingHeaders(rawHeaders: string | undefined): string[] {
  if (!rawHeaders?.trim()) return [];
  try {
    const parsed = JSON.parse(rawHeaders);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed).filter((name) => SECRET_NAME.test(name));
  } catch {
    return SECRET_NAME.test(rawHeaders) ? ["(headers)"] : [];
  }
}
