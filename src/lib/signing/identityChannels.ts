/**
 * Which verification channels a given signer may actually use.
 *
 * Pure, and free of any server binding, so the rule can be tested and reasoned
 * about on its own. Getting it wrong is not a cosmetic bug: offering a channel
 * that cannot be reached strands a customer at a prompt with no way forward, and
 * offering one the document did not ask for quietly weakens the check somebody
 * deliberately turned on.
 */

export type IdentityChannel = "email" | "sms";

export type ChannelOffer = { channel: IdentityChannel; hint: string };

export type ChannelSubject = {
  email: string | null;
  phone: string | null;
  identityMode: string;
};

/** Enough for the real signer to recognise their address; not enough to learn it. */
export function emailHint(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, 2)}${"•".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

/** Same bargain for a mobile number: the last few digits only. */
export function phoneHint(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `••• ••• •${digits.slice(-3)}`;
}

/**
 * The INTERSECTION of what the document asks for and what we hold for this
 * signer. An empty result is a meaningful answer — "this document wants a code
 * and we have nowhere to send one" — and the caller is expected to say so
 * rather than render a button that cannot work.
 */
export function offeredChannels(subject: ChannelSubject): ChannelOffer[] {
  const { identityMode } = subject;
  const out: ChannelOffer[] = [];
  const email = subject.email?.trim();
  const phone = subject.phone?.trim();
  if ((identityMode === "email_otp" || identityMode === "otp") && email) {
    out.push({ channel: "email", hint: emailHint(email) });
  }
  if ((identityMode === "sms_otp" || identityMode === "otp") && phone) {
    out.push({ channel: "sms", hint: phoneHint(phone) });
  }
  return out;
}

/** `link` means possession of the URL is the whole check. */
export function identityRequired(identityMode: string): boolean {
  return identityMode !== "link";
}
