/**
 * The SSRF address policy, and the undici dispatcher that enforces it at connect
 * time.
 *
 * Split out of ./safeFetch so it can be TESTED. safeFetch carries
 * `import "server-only"`, which throws outside a Next server context, so nothing
 * in tests/ could import it — the entire SSRF guard had no test at all. That
 * matters most exactly when undici moves: this file is the only thing in the
 * app that uses undici directly, and what it uses is `Agent`'s custom
 * `connect.lookup` hook. A major bump can change that contract without changing
 * a single type, and the app would still compile and still build while quietly
 * connecting to whatever DNS returned.
 *
 * Kept free of `server-only` on purpose. Nothing here touches a request, a
 * session, or a secret — it is address arithmetic plus a DNS callback.
 */
import dnsCb from "node:dns";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";
import ipaddr from "ipaddr.js";

export const ALLOWED_PORTS = new Set([80, 443]);

/**
 * True for any IP we must never connect to. Uses ipaddr.js so every form is
 * handled robustly — including all IPv4-mapped IPv6 encodings (::ffff:127.0.0.1
 * AND the hex form ::ffff:7f00:1), 6to4/Teredo, unique-local, CGNAT, etc. Only a
 * genuine global unicast address is treated as safe.
 */
export function isPrivateIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // unparseable → refuse
  }
  // Collapse IPv4-mapped IPv6 to its embedded IPv4 and range-check that.
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  // ipaddr.js labels only publicly-routable unicast as "unicast"; every other
  // range (private, loopback, linkLocal, uniqueLocal, reserved, multicast,
  // carrierGradeNat, 6to4, teredo, …) is unsafe for an outbound SSRF-guarded fetch.
  return addr.range() !== "unicast";
}

/** Hostnames we refuse outright, before any DNS. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true; // cloud metadata
  if (net.isIP(h) && isPrivateIp(h)) return true;
  return false;
}

export function validateUrl(raw: string): URL {
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
export async function assertResolvesPublic(hostname: string): Promise<void> {
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
 * The lookup undici calls at connect time, factored out so a test can drive it
 * directly and so `allow` can be swapped for a control case.
 *
 * This is the anti-rebinding step: the pre-flight check in assertResolvesPublic
 * happens before the socket exists, and DNS can answer differently a moment
 * later. Filtering HERE means the address the socket actually connects to is
 * one we vetted.
 */
export function makePinnedLookup(allow: (address: string) => boolean = (a) => !isPrivateIp(a)) {
  return (
    hostname: string,
    options: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ) => {
    dnsCb.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, "", 0);
      const list = Array.isArray(addresses) ? addresses : [];
      const safe = list.filter((a) => allow(a.address));
      if (!safe.length) return cb(new Error("Blocked: host resolves only to private addresses"), "", 0);
      if (options && (options as { all?: boolean }).all) {
        // undici asked for the full list — hand back only the vetted ones
        return (cb as unknown as (e: Error | null, a: typeof safe) => void)(null, safe);
      }
      cb(null, safe[0].address, safe[0].family);
    });
  };
}

/**
 * undici dispatcher whose DNS lookup re-validates at actual connect time and pins the socket to a
 * vetted address — so a name that passed our pre-check can't rebind to a private IP mid-connect.
 */
export const pinnedAgent = new Agent({ connect: { lookup: makePinnedLookup() } });
