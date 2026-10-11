/**
 * Is the workspace's sending domain set up so its email is trusted? — the rules,
 * pure (Sean, 2026-10-11, after looking at Mimecast's DMARC Analyzer).
 *
 * Three public DNS records decide whether Gmail and Outlook believe an email
 * really came from a domain: SPF (which servers may send for it), DKIM (a
 * signature on each message) and DMARC (what to do with mail that fails the
 * other two). When they are missing, a quote lands in spam and nobody is told.
 *
 * This reads the records and says what it found in plain words. It is honest
 * about what DNS cannot tell it: SPF being present does not prove it names the
 * RIGHT mail server, and a DKIM record lives under a name ("selector") only the
 * mail provider knows — so "not found" for DKIM means "not under the usual
 * names", and is reported as unknown, never as broken.
 */

export type DomainCheckState = "good" | "warn" | "bad" | "unknown";
export type DomainCheck = { key: "spf" | "dkim" | "dmarc"; label: string; state: DomainCheckState; found: string; meaning: string; fix: string };

/** The names mail providers most often publish a DKIM key under. Tried in this order. */
export const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "dkim", "mail", "k1", "k2", "s1", "s2", "smtp", "mx", "resend", "sendgrid", "amazonses", "mandrill", "pm", "zoho", "protonmail"] as const;

/** The domain mail is sent as: from `"Name" <sales@example.co.za>`, or the mailbox login when From is only a name. */
export function sendingDomainOf(from: string | null | undefined, smtpUser?: string | null): string | null {
  for (const candidate of [from, smtpUser]) {
    const match = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(candidate ?? "");
    if (match) return match[2].toLowerCase();
  }
  return null;
}

const record = (records: readonly string[], prefix: RegExp) => records.map((r) => r.trim()).filter((r) => prefix.test(r));

export function assessSendingDomain(input: {
  domain: string;
  /** TXT records at the domain itself. */
  txt: readonly string[];
  /** TXT records at _dmarc.<domain>. */
  dmarc: readonly string[];
  /** The DKIM selector a key was found under, or null when none of DKIM_SELECTORS had one. */
  dkimSelector: string | null;
  /** The outgoing mail server from Settings, named in the SPF advice. */
  smtpHost?: string | null;
}): DomainCheck[] {
  const { domain } = input;
  const host = input.smtpHost?.trim() || "your mail provider";

  const spfRecords = record(input.txt, /^v=spf1(\s|$)/i);
  const spf = spfRecords[0] ?? "";
  const spfAll = /\s([+\-~?]?)all\s*$/i.exec(spf)?.[1] ?? null;
  const spfCheck: DomainCheck =
    spfRecords.length === 0
      ? { key: "spf", label: "SPF", state: "bad", found: "No SPF record.", meaning: "Nothing tells other mail systems which servers may send for this domain, so your email is more likely to be treated as spam.", fix: `Ask whoever manages ${domain}'s DNS to add the SPF record ${host} gives you.` }
      : spfRecords.length > 1
        ? { key: "spf", label: "SPF", state: "bad", found: `${spfRecords.length} SPF records.`, meaning: "A domain may have only one. With more than one, mail systems ignore them all.", fix: "Merge them into a single SPF record." }
        : spfAll === "+" || (spfAll === "" && /\sall\s*$/i.test(spf))
          ? { key: "spf", label: "SPF", state: "bad", found: spf, meaning: "It ends in “all”, which allows anyone at all to send as this domain.", fix: "Change the ending to “~all” or “-all”." }
          : // A record that hands over to another with redirect= has no "all" of its own, and is complete.
            (spfAll === null && !/\sredirect=/i.test(spf)) || spfAll === "?"
            ? { key: "spf", label: "SPF", state: "warn", found: spf, meaning: "It lists senders but does not say what to do with anyone else, so it protects very little.", fix: "End the record with “~all” (or “-all” once you are sure every sender is listed)." }
            : { key: "spf", label: "SPF", state: "good", found: spf, meaning: `A record is in place. This check cannot tell whether it names ${host} — if email still lands in spam, confirm that with them.`, fix: "" };

  const dkimCheck: DomainCheck = input.dkimSelector
    ? { key: "dkim", label: "DKIM", state: "good", found: `A signing key is published (under “${input.dkimSelector}”).`, meaning: "Your mail can be signed so that other mail systems can prove it was not altered.", fix: "" }
    : { key: "dkim", label: "DKIM", state: "unknown", found: "No signing key under the usual names.", meaning: "That does not mean there is none: the key sits under a name only your mail provider knows, and this check can only try the common ones.", fix: `Ask ${host} whether DKIM signing is switched on for ${domain}.` };

  const dmarcRecords = record(input.dmarc, /^v=DMARC1(\s*;|\s|$)/i);
  const dmarc = dmarcRecords[0] ?? "";
  const policy = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(dmarc)?.[1]?.toLowerCase() ?? "";
  const dmarcCheck: DomainCheck =
    dmarcRecords.length === 0
      ? { key: "dmarc", label: "DMARC", state: "bad", found: "No DMARC record.", meaning: "Gmail and Outlook expect one from any business that sends email. Without it, anyone can send mail that looks like yours and nothing stops it.", fix: `Add a TXT record at _dmarc.${domain}. A safe first one is: v=DMARC1; p=none; rua=mailto:postmaster@${domain}` }
      : dmarcRecords.length > 1
        ? { key: "dmarc", label: "DMARC", state: "bad", found: `${dmarcRecords.length} DMARC records.`, meaning: "A domain may have only one. With more than one, it counts as having none.", fix: "Keep one and remove the rest." }
        : policy === "reject" || policy === "quarantine"
          ? { key: "dmarc", label: "DMARC", state: "good", found: dmarc, meaning: `Mail that fails the checks is ${policy === "reject" ? "refused" : "sent to spam"}. Your domain is protected against being imitated.`, fix: "" }
          : policy === "none"
            ? { key: "dmarc", label: "DMARC", state: "warn", found: dmarc, meaning: "The record is there, but set to watch only: mail imitating your domain is still delivered.", fix: "Once SPF and DKIM pass for your own mail, change p=none to p=quarantine." }
            : { key: "dmarc", label: "DMARC", state: "bad", found: dmarc, meaning: "The record has no valid policy (p=none, p=quarantine or p=reject), so it is ignored.", fix: "Add a policy, starting with p=none." };

  return [spfCheck, dkimCheck, dmarcCheck];
}

/** One line for the top of the card. Unknown is not a problem; it is something to ask about. */
export function sendingDomainVerdict(checks: readonly DomainCheck[]): { state: DomainCheckState; text: string } {
  const bad = checks.filter((c) => c.state === "bad").map((c) => c.label);
  const warn = checks.filter((c) => c.state === "warn").map((c) => c.label);
  if (bad.length) return { state: "bad", text: `${bad.join(" and ")} ${bad.length === 1 ? "needs" : "need"} fixing — until then, some of your email is likely to land in spam.` };
  if (warn.length) return { state: "warn", text: `Working, but ${warn.join(" and ")} could be stronger.` };
  if (checks.some((c) => c.state === "unknown")) return { state: "unknown", text: "SPF and DMARC are in place. DKIM could not be confirmed from here." };
  return { state: "good", text: "SPF, DKIM and DMARC are all in place." };
}
