import "server-only";
import dnsCb from "node:dns";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

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
 */

const ALLOWED_PORTS = new Set([80, 443]);
const MAX_REDIRECTS = 4;
const DEFAULT_MAX_BYTES = 3_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** True for any IP we must never connect to (private, loopback, link-local, CGNAT, metadata, multicast). */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((n) => Number.isNaN(n))) return true;
    if (p[0] === 0) return true; // "this" network
    if (p[0] === 10) return true; // private
    if (p[0] === 127) return true; // loopback
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. 169.254.169.254 (cloud metadata)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // private
    if (p[0] === 192 && p[1] === 168) return true; // private
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true; // IETF protocol assignments
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // multicast + reserved (224-255)
    return false;
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    if (h.startsWith("fe80")) return true; // link-local
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local
    if (h.startsWith("fec0")) return true; // deprecated site-local
    if (h.startsWith("ff")) return true; // multicast
    if (h.startsWith("2001:db8")) return true; // documentation
    if (h.startsWith("64:ff9b")) return true; // NAT64 (could bridge to private)
    if (h.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 — validate the embedded v4
      const tail = h.split("::ffff:")[1] ?? "";
      if (tail.includes(".")) return isPrivateIp(tail);
    }
    return false;
  }
  return true; // not a recognisable IP → refuse
}

/** Hostnames we refuse outright, before any DNS. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true; // cloud metadata
  if (net.isIP(h) && isPrivateIp(h)) return true;
  return false;
}

function validateUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Blocked protocol: ${u.protocol}`);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) throw new Error(`Blocked port: ${port}`);
  if (isBlockedHost(u.hostname)) throw new Error("Blocked host");
  return u;
}

/** Resolve a hostname and reject if ANY resolved address is private/reserved. */
async function assertResolvesPublic(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Blocked: private/reserved IP literal");
    return;
  }
  const results = await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!results.length) throw new Error("Blocked: DNS returned no addresses");
  for (const r of results) {
    if (isPrivateIp(r.address)) throw new Error(`Blocked: ${hostname} resolves to private ${r.address}`);
  }
}

/**
 * undici dispatcher whose DNS lookup re-validates at actual connect time and pins the socket to a
 * vetted address — so a name that passed our pre-check can't rebind to a private IP mid-connect.
 */
const pinnedAgent = new Agent({
  connect: {
    lookup: (hostname, options, cb) => {
      dnsCb.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return cb(err, "", 0);
        const list = Array.isArray(addresses) ? addresses : [];
        const safe = list.filter((a) => !isPrivateIp(a.address));
        if (!safe.length) return cb(new Error("Blocked: host resolves only to private addresses"), "", 0);
        if (options && (options as { all?: boolean }).all) {
          // undici asked for the full list — hand back only the vetted ones
          return (cb as unknown as (e: Error | null, a: typeof safe) => void)(null, safe);
        }
        cb(null, safe[0].address, safe[0].family);
      });
    },
  },
});

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
