/**
 * The sentence a signer agrees to when they tick the box.
 *
 * It used to live only in the signing page's markup. The server checked that the
 * box was ticked and kept no record of WHAT had been agreed to, so the evidence
 * said "consented" without being able to say to which words — and the words can
 * change. Each version is kept here for good and the one shown is written into
 * the signer's `signed` event, inside the tamper-evident chain.
 *
 * Pure (no server binding): the signing page renders the current text and the
 * route records it, from the same definition.
 *
 * Never edit a published version's text. Add a new one and move CURRENT.
 */
export type SigningConsent = { version: string; text: string };

const VERSIONS: Record<string, string> = {
  "za-ecta-v1":
    "I agree to sign this document electronically. My electronic signature is legally binding under the Electronic Communications and Transactions Act 25 of 2002 (South Africa).",
};

const CURRENT = "za-ecta-v1";

/** What the signing page shows today. */
export const SIGNING_CONSENT: SigningConsent = { version: CURRENT, text: VERSIONS[CURRENT] };

/**
 * The consent a submission agreed to.
 *
 * A page opened before versions were sent names none: every page ever served
 * until then showed "za-ecta-v1", so that is what an unnamed submission agreed
 * to. A version this server has never published is refused (null) rather than
 * recorded as something the signer may not have seen.
 */
export function consentFor(version: string | undefined): SigningConsent | null {
  const key = version ?? "za-ecta-v1";
  const text = VERSIONS[key];
  return text ? { version: key, text } : null;
}
