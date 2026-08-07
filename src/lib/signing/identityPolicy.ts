import type { SigningIdentityMode } from "./service";

/**
 * When a signer should have to prove who they are.
 *
 * The judgement this encodes: a step-up is worth real friction on a document
 * that moves money, and is needless on a delivery note. Applying it to
 * everything is how a step-up becomes something people route around, and
 * applying it to nothing leaves "who signed" resting on whoever happened to
 * receive the email — a forwarded message, a shared sales inbox, a mail-scanning
 * proxy.
 *
 * So the default is MONEY: a quote, or anything else with a value attached, asks
 * for a one-time code; routine paperwork does not. Every part of it is a
 * setting, and the person preparing a document can always override it for that
 * document.
 */

export type SigningOtpPolicy = "off" | "money" | "always";

export const SIGNING_OTP_POLICY_KEY = "SIGNING_OTP_POLICY";
export const SIGNING_OTP_MIN_VALUE_KEY = "SIGNING_OTP_MIN_VALUE";

/** What a workspace gets before anybody changes anything. */
export const DEFAULT_OTP_POLICY: SigningOtpPolicy = "money";
/**
 * Zero, so "money" means any document carrying a value rather than only large
 * ones. A threshold is available for workspaces that quote small amounts all day
 * and only care above a number — but choosing that number is their call, and
 * defaulting to one would silently exempt documents nobody decided to exempt.
 */
export const DEFAULT_OTP_MIN_VALUE = 0;

export function parseOtpPolicy(raw: string | null | undefined): SigningOtpPolicy {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "off" || value === "always" || value === "money" ? value : DEFAULT_OTP_POLICY;
}

export function parseOtpMinValue(raw: string | null | undefined): number {
  const value = Number((raw ?? "").trim());
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_OTP_MIN_VALUE;
}

export type DocumentValue = {
  /** Total on the source record, if it has one. Null when nothing is attached. */
  amount: number | null;
};

/**
 * Resolve the identity mode for a document about to be prepared.
 *
 * `explicit` is whatever the person preparing it chose, and always wins — the
 * policy sets the default, it does not overrule a human looking at the specific
 * document in front of them.
 *
 * `otp` rather than a single channel: it asks for real proof without betting the
 * signature on one route still working. A stale mobile number or an abandoned
 * mailbox is the ordinary reason a verified signature stalls, and letting the
 * signer use whichever they still have is what keeps the check from becoming a
 * phone call to the sender.
 */
export function resolveIdentityMode(input: {
  explicit?: SigningIdentityMode | null;
  policy: SigningOtpPolicy;
  minValue: number;
  value: DocumentValue;
}): SigningIdentityMode {
  if (input.explicit) return input.explicit;
  if (input.policy === "off") return "link";
  if (input.policy === "always") return "otp";

  // "money": a value must be attached AND meet the threshold.
  const amount = input.value.amount;
  if (amount === null) return "link";
  return amount >= input.minValue ? "otp" : "link";
}
