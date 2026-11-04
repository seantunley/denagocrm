import "server-only";
import { decryptValue, getSetting } from "./settings";
import { FLOW_CONNECTIONS_KEY, connectionAllows, parseConnections } from "./flowConnections";

/**
 * The decrypted headers of one of this workspace's connections, for a request to `url` — refused when the connection
 * is gone or `url` is not on its host. Called at send time only; the values are never returned to a page or logged.
 */
export async function connectionHeaders(connectionId: string, url: string): Promise<{ ok: true; headers: [string, string][] } | { ok: false; reason: string }> {
  const connection = parseConnections(await getSetting(FLOW_CONNECTIONS_KEY)).find((c) => c.id === connectionId);
  if (!connection) return { ok: false, reason: "That connection no longer exists" };
  if (!connectionAllows(connection, url)) return { ok: false, reason: `This connection may only be used with ${connection.host}` };
  try {
    return { ok: true, headers: connection.headers.map((h) => [h.name, decryptValue(h.value)]) };
  } catch {
    return { ok: false, reason: "The connection's key could not be read" };
  }
}
