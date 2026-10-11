"use server";

import { resolveTxt } from "node:dns/promises";
import { withActingStaffScope } from "@/lib/actingScope";
import { requireTenantOwner } from "@/lib/auth";
import { getSmtpConfig } from "@/lib/email";
import { DKIM_SELECTORS, assessSendingDomain, sendingDomainOf, sendingDomainVerdict, type DomainCheck, type DomainCheckState } from "@/lib/sendingDomain";

export type SendingDomainReport =
  | { ok: true; domain: string; verdict: { state: DomainCheckState; text: string }; checks: DomainCheck[] }
  | { ok: false; error: string };

const TIMEOUT_MS = 4000;

/**
 * TXT records at a name, joined as DNS means them (one record can arrive in
 * several strings). "No such name" and "no records" are an empty list — that is
 * an answer. Anything else (a timeout, no resolver) is `null`: we do not know,
 * and must not report a record as missing because the lookup failed.
 */
async function txt(name: string): Promise<string[] | null> {
  try {
    const records = await Promise.race([
      resolveTxt(name),
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), TIMEOUT_MS)),
    ]);
    return records.map((parts) => parts.join(""));
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? [] : null;
  }
}

/**
 * Look up the workspace's sending domain in public DNS and say whether its
 * email is set up to be trusted (lib/sendingDomain.ts). Owner only, on demand,
 * read-only: it asks DNS three kinds of question and changes nothing. The only
 * thing it sends anywhere is the domain name itself, to the DNS resolver.
 */
export async function checkSendingDomain(): Promise<SendingDomainReport> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const config = await getSmtpConfig();
    if (!config) return { ok: false as const, error: "Set up outgoing email first — there is no sending address to check yet." };
    const domain = sendingDomainOf(config.from, config.user);
    if (!domain) return { ok: false as const, error: "The From address has no email address in it, so there is no domain to check." };

    const [root, dmarc, keys] = await Promise.all([
      txt(domain),
      txt(`_dmarc.${domain}`),
      Promise.all(DKIM_SELECTORS.map(async (selector) => ({ selector, records: await txt(`${selector}._domainkey.${domain}`) }))),
    ]);
    if (root === null || dmarc === null) return { ok: false as const, error: "The lookup did not get an answer. Try again in a minute." };

    const dkimSelector = keys.find((key) => key.records?.some((value) => /(^|;)\s*p=[A-Za-z0-9+/]/.test(value) || /v=DKIM1/i.test(value)))?.selector ?? null;
    const checks = assessSendingDomain({ domain, txt: root, dmarc, dkimSelector, smtpHost: config.host });
    return { ok: true as const, domain, verdict: sendingDomainVerdict(checks), checks };
  });
}
