import "server-only";
import type { Agent } from "undici";
import { assertResolvesPublic, pinnedAgent, validateUrl } from "./ssrfGuard";

/**
 * SSRF-hardened fetch for pulling untrusted public URLs (competitor pages, etc.).
 *
 * Defences, layered:
 *  - protocol + port allow-list
 *  - literal-host block (localhost, .internal, cloud-metadata names, IP literals in private ranges)
 *  - DNS resolution with private/reserved IPv4 AND IPv6 blocking, re-checked immediately before
 *    every connection (each redirect hop re-resolves)
 *  - connection pinned to a validated address via a custom undici lookup, closing the DNS-rebinding
 *    (TOCTOU) window between our check and the socket connect
 *  - manual redirect handling: every hop is re-validated, with a hard redirect cap
 *  - hard streamed byte cap so a hostile/broken server can't exhaust memory before we slice
 *
 * The address policy and the undici dispatcher live in ./ssrfGuard, which has no
 * `server-only` marker so the guard can actually be tested. This module is the
 * request loop around it.
 */

const MAX_REDIRECTS = 4;
const DEFAULT_MAX_BYTES = 3_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export { isPrivateIp } from "./ssrfGuard";

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`Response exceeds ${maxBytes}-byte limit`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type SafeFetchResult = { status: number; contentType: string; text: string; finalUrl: string };

/** Fetch a public URL's body as text, with SSRF hardening and a hard size cap. */
export async function safeFetchText(
  rawUrl: string,
  opts?: { maxBytes?: number; timeoutMs?: number; userAgent?: string; accept?: string },
): Promise<SafeFetchResult> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = rawUrl;

  for (let hop = 0; ; hop++) {
    const u = validateUrl(current);
    await assertResolvesPublic(u.hostname); // immediate pre-connect DNS re-check

    const res = await fetch(u.toString(), {
      method: "GET",
      redirect: "manual", // we validate each hop ourselves
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        "User-Agent": opts?.userAgent ?? "DenagoCRM-Fetch/1.0 (+https://crm.denagocpt.co.za)",
        Accept: opts?.accept ?? "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5",
      },
      // undici extension; not in the DOM RequestInit type
      dispatcher: pinnedAgent,
    } as RequestInit & { dispatcher: Agent });

    if (res.status >= 300 && res.status < 400) {
      // Drain/allow GC of the redirect body.
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect ${res.status} without Location`);
      current = new URL(loc, u).toString(); // resolve relative, re-validated next iteration
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const text = await readCapped(res, maxBytes);
    return { status: res.status, contentType, text, finalUrl: u.toString() };
  }
}
