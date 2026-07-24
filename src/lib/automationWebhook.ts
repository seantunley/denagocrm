import "server-only";

import crypto from "crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

export async function validateAutomationWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Webhook URL is invalid"); }
  if (url.protocol !== "https:") throw new Error("Automation webhooks must use HTTPS");
  if (url.username || url.password) throw new Error("Webhook URLs cannot contain credentials");
  const host = url.hostname.toLowerCase();
  if (["localhost", "localhost.localdomain"].includes(host) || host.endsWith(".local")) {
    throw new Error("Local webhook destinations are not allowed");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Private webhook destinations are not allowed");
  } else {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error("Webhook destination resolves to a private network");
    }
  }
  return url;
}

export async function callAutomationWebhook(args: {
  url: string;
  payload: Record<string, unknown>;
  secret?: string | null;
  idempotencyKey: string;
}): Promise<{ status: number; body: string }> {
  const url = await validateAutomationWebhookUrl(args.url);
  const body = JSON.stringify(args.payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = args.secret
    ? crypto.createHmac("sha256", args.secret).update(`${timestamp}.${body}`).digest("hex")
    : null;
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
    headers: {
      "content-type": "application/json",
      "user-agent": "DenagoCRM-Automation/1.0",
      "x-denago-timestamp": timestamp,
      "x-denago-idempotency-key": args.idempotencyKey,
      ...(signature ? { "x-denago-signature": `sha256=${signature}` } : {}),
    },
    body,
  });
  const responseBody = (await response.text()).slice(0, 2000);
  if (!response.ok) throw new Error(`Webhook returned ${response.status}${responseBody ? `: ${responseBody}` : ""}`);
  return { status: response.status, body: responseBody };
}
