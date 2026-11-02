"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireTenantOwner } from "@/lib/auth";
import { encryptValue, getSetting, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { FLOW_CONNECTIONS_KEY, connectionHost, parseConnections } from "@/lib/flowConnections";

/**
 * Flows → Connections (lib/flowConnections.ts). Owner only. A value is encrypted the moment it arrives and is never
 * sent back to a page, put in an audit line or logged — the audit names the connection and its header NAMES only.
 */

const PAGE = "/bot-builder/connections";
const HEADER = /^[A-Za-z0-9-]{1,60}$/;

export async function addConnection(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const host = connectionHost(String(formData.get("host") ?? ""));
    if (!name) refuse("Give the connection a name, e.g. Sage API.");
    if (!host) refuse("Enter the API's address, e.g. api.sage.com — the key is only ever sent there.");
    const headers: { name: string; value: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const header = String(formData.get(`header${i}`) ?? "").trim();
      const value = String(formData.get(`value${i}`) ?? "");
      if (!header && !value) continue;
      if (!HEADER.test(header) || !value.trim()) refuse("Each header needs a name (e.g. Authorization) and a value.");
      headers.push({ name: header, value: encryptValue(value.trim()) });
    }
    if (!headers.length) refuse("Add at least one header — the key itself.");
    const list = parseConnections(await getSetting(FLOW_CONNECTIONS_KEY));
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) refuse("A connection with that name already exists.");
    await putSetting(FLOW_CONNECTIONS_KEY, JSON.stringify([...list, { id: crypto.randomUUID(), name, host, headers }]));
    await logAudit({ action: "bot.connection_added", summary: `Connection “${name}” for ${host} added (headers: ${headers.map((h) => h.name).join(", ")})`, user });
    revalidatePath(PAGE);
    return { success: "Connection saved" };
  });
}

export async function deleteConnection(id: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const list = parseConnections(await getSetting(FLOW_CONNECTIONS_KEY));
    const gone = list.find((c) => c.id === id);
    if (!gone) return { success: "Already removed" };
    await putSetting(FLOW_CONNECTIONS_KEY, JSON.stringify(list.filter((c) => c.id !== id)));
    await logAudit({ action: "bot.connection_deleted", summary: `Connection “${gone.name}” deleted — steps using it now fail until another is chosen`, user });
    revalidatePath(PAGE);
    return { success: "Connection deleted" };
  });
}
