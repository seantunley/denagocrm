// Guided setup definitions for outbound integrations: a credential is entered
// across a few small, individually-validated steps, and is committed only after
// a REAL connection test has proved it works.
//
// The sequencing is not decoration. Entering six SMTP fields into one form and
// pressing Save tells the owner nothing about which of the six was wrong, and
// storing them unverified means the first evidence of a mistake is a customer's
// email that never arrived. Small steps let each answer be checked while the
// owner is still thinking about it, and holding the commit until the provider
// itself has accepted the credential means "saved" and "working" cannot drift
// apart.
//
// Deliberately free of server/db/network imports — like tenantCredentialFields.ts,
// this is plain metadata + pure functions, so it can be imported by both the
// "use server" actions file and the client wizard component, and unit-tested
// without a database or a socket.
//
// The step ids are load-bearing beyond navigation: a probe failure reports a
// `blameStep` (see integrationProbe.ts), and the reauth path uses it to reopen
// the flow at the step that actually needs fixing rather than at step 1.

import { TENANT_CREDENTIAL_INTEGRATIONS, type TenantCredentialField } from "./tenantCredentialFields";

/**
 * The terminal step of every flow: the live connection test. It is also the
 * `blameStep` for failures no field can fix (provider outage, rate limit,
 * transient network error) — "change nothing, try again" — which keeps the UI
 * from sending someone back to re-type a password that was never the problem.
 */
export const VERIFY_STEP_ID = "verify";

export type FlowStep = {
  id: string;
  title: string;
  /** One line telling the user what this step wants and where to find it. */
  blurb: string;
  /** Credential keys collected at this step, in render order. */
  fieldKeys: readonly string[];
};

export type IntegrationFlow = {
  integrationId: string;
  label: string;
  steps: readonly FlowStep[];
};

/**
 * Flows exist for the two providers with the clearest existing code path:
 *
 *  - smtp     — src/lib/email.ts already resolves the whole bundle through
 *               resolveIntegrationBundle("smtp"), and nodemailer's verify()
 *               is a genuine authenticated SMTP session, not a ping.
 *  - whatsapp — src/lib/whatsapp.ts also uses resolveIntegrationBundle, and its
 *               two credential fields are independently falsifiable: a Graph
 *               read of the phone-number id proves the TOKEN is live *and* that
 *               it can see THAT number, so the probe can name which of the two
 *               is wrong instead of returning one undifferentiated failure.
 *
 * The other five integrations keep the existing single-field override UI. Adding
 * a flow for one is purely additive: define its steps here and a probe there.
 */
export const INTEGRATION_FLOWS: readonly IntegrationFlow[] = [
  {
    integrationId: "smtp",
    label: "Outbound email (SMTP)",
    steps: [
      {
        id: "server",
        title: "Mail server",
        blurb:
          "Where your mail is submitted. Your provider lists this as the SMTP or outgoing server — port 587 with encryption on suits almost every provider.",
        fieldKeys: ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE"],
      },
      {
        id: "credentials",
        title: "Sign in",
        blurb:
          "The mailbox credentials used to submit mail. If your provider requires an app password, use that rather than the account password.",
        fieldKeys: ["SMTP_USER", "SMTP_PASS"],
      },
      {
        id: "identity",
        title: "Sender address",
        blurb: "The From address recipients will see. Most servers reject mail sent as an address you don't own.",
        fieldKeys: ["SMTP_FROM"],
      },
      {
        id: VERIFY_STEP_ID,
        title: "Test connection",
        blurb: "We open a real SMTP session and sign in. Nothing is saved unless this succeeds.",
        fieldKeys: [],
      },
    ],
  },
  {
    integrationId: "whatsapp",
    label: "WhatsApp Business (Cloud API)",
    steps: [
      {
        id: "identity",
        title: "Phone number",
        blurb:
          "The Phone number ID from Meta → WhatsApp → API Setup. This is the long numeric id under your number, not the number itself.",
        fieldKeys: ["WA_PHONE_NUMBER_ID"],
      },
      {
        id: "credentials",
        title: "Access token",
        blurb:
          "A permanent System User token with the whatsapp_business_messaging permission. Temporary tokens from the API Setup page expire after 24 hours.",
        fieldKeys: ["WA_ACCESS_TOKEN"],
      },
      {
        id: VERIFY_STEP_ID,
        title: "Test connection",
        blurb:
          "We ask Meta to describe your number using this token, then check that your webhook is reachable. Nothing is saved unless the token works.",
        fieldKeys: [],
      },
    ],
  },
];

export function getIntegrationFlow(integrationId: string): IntegrationFlow | null {
  return INTEGRATION_FLOWS.find((f) => f.integrationId === integrationId) ?? null;
}

export function hasIntegrationFlow(integrationId: string): boolean {
  return getIntegrationFlow(integrationId) !== null;
}

/** Every credential key a flow collects, across all its steps. */
export function flowFieldKeys(flow: IntegrationFlow): string[] {
  return flow.steps.flatMap((s) => [...s.fieldKeys]);
}

/**
 * Keys the WIZARD insists on, even though the shared catalogue marks them
 * optional.
 *
 * `required: false` on SMTP_SECURE is right for the per-key overrides page,
 * where blank honestly means "leave whatever is stored alone". It is wrong here,
 * because this flow's whole promise is that what got tested is what got saved —
 * and blank broke that in both directions. The probe read blank as `false` and
 * tested an unencrypted connection, while `putTenantCredentialBundle` skips
 * empty values, so an existing `SMTP_SECURE=true` override survived untouched
 * (or, with no override, the tenant kept falling back to a platform value that
 * may be either). Either way the bundle that was verified is not the bundle that
 * is stored — exactly the thing this feature exists to make impossible.
 *
 * The honest fix is to refuse to guess: encryption is on or off, the owner says
 * which, and the value that passes the test is the value that gets written.
 */
const REQUIRED_IN_FLOW: ReadonlySet<string> = new Set(["SMTP_SECURE"]);

function requiredInFlow(key: string): boolean {
  return REQUIRED_IN_FLOW.has(key);
}

/**
 * Which guided flows a credential key belongs to.
 *
 * Powers verification invalidation: the per-key save/clear controls in the
 * overrides page write `TenantIntegrationCredential` directly, without going
 * near the wizard, so whatever `IntegrationConnection` says about that
 * integration stops being true the moment one of its keys changes. This maps the
 * edited key back to the affected integration(s) so the stale verdict can be
 * dropped rather than left on screen.
 *
 * A list, not a single id, because nothing stops two flows sharing a key.
 */
export function integrationsUsingCredentialKey(key: string): string[] {
  return INTEGRATION_FLOWS.filter((flow) => flowFieldKeys(flow).includes(key)).map((flow) => flow.integrationId);
}

/** Field metadata (label/placeholder/required) for a key, from the shared catalogue. */
export function flowField(integrationId: string, key: string): TenantCredentialField | null {
  const integration = TENANT_CREDENTIAL_INTEGRATIONS.find((i) => i.id === integrationId);
  return integration?.fields.find((f) => f.key === key) ?? null;
}

export type FieldErrors = Record<string, string>;

/**
 * Per-field shape checks.
 *
 * INVARIANT: a message here must never interpolate the submitted value. These
 * strings are rendered in the browser and (for the verify step) can end up in an
 * audit summary, so echoing the input back would leak a password the moment
 * someone fat-fingers it into the wrong box. Describe the RULE, never the value.
 * Enforced by tests/integrationFlow.test.ts.
 */
const VALIDATORS: Record<string, (raw: string) => string | null> = {
  SMTP_HOST: (v) => {
    if (!v) return "Enter your mail server's hostname.";
    if (/^[a-z]+:\/\//i.test(v)) return "Enter the hostname only, without a https:// or smtp:// prefix.";
    if (/[\s/]/.test(v)) return "A hostname can't contain spaces or slashes.";
    if (v.includes("@")) return "That looks like an email address. Enter the server's hostname instead.";
    if (!/^[a-z0-9.-]+$/i.test(v)) return "That isn't a valid hostname.";
    return null;
  },
  SMTP_PORT: (v) => {
    if (!v) return "Enter the submission port — usually 587.";
    if (!/^\d+$/.test(v)) return "The port must be a whole number.";
    const port = Number(v);
    if (port < 1 || port > 65535) return "The port must be between 1 and 65535.";
    return null;
  },
  SMTP_SECURE: (v) => (v === "true" || v === "false" ? null : "Choose whether encryption is on or off."),
  SMTP_USER: (v) => (v ? null : "Enter the username your mail server expects."),
  SMTP_PASS: (v) => (v ? null : "Enter the password for this mailbox."),
  SMTP_FROM: (v) => {
    if (!v) return "Enter the address your email should come from.";
    // Accepts a bare address or a "Display Name <addr@example.com>" header.
    const bracketed = /<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>\s*$/.exec(v);
    const address = bracketed ? bracketed[1] : v;
    if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(address)) {
      return "That isn't a valid email address. Use name@example.com, or Display Name <name@example.com>.";
    }
    return null;
  },
  WA_PHONE_NUMBER_ID: (v) => {
    if (!v) return "Enter the Phone number ID from Meta → WhatsApp → API Setup.";
    if (/^\+?[\d\s()-]{7,20}$/.test(v) && !/^\d{5,25}$/.test(v)) {
      return "That looks like the phone number itself. The Phone number ID is the long numeric id shown beneath it.";
    }
    if (!/^\d{5,25}$/.test(v)) return "A Phone number ID is 5–25 digits with nothing else in it.";
    return null;
  },
  WA_ACCESS_TOKEN: (v) => {
    if (!v) return "Paste the System User access token.";
    if (/\s/.test(v)) return "The token has whitespace in it — it was probably copied with a line break.";
    if (v.length < 20) return "That token is too short to be a Meta access token.";
    return null;
  },
};

/**
 * Validates ONE step's fields. Returns `{}` when the step is good.
 *
 * Only the step's own keys are examined, so a later step's blank field never
 * blocks an earlier "Next" — that is what makes the flow feel like a sequence
 * rather than one big form validated all at once.
 */
export function validateFlowStep(
  integrationId: string,
  stepId: string,
  values: Readonly<Record<string, string>>,
): FieldErrors {
  const flow = getIntegrationFlow(integrationId);
  if (!flow) return {};
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) return {};

  const errors: FieldErrors = {};
  for (const key of step.fieldKeys) {
    const field = flowField(integrationId, key);
    const raw = (values[key] ?? "").trim();
    // An optional field may be left blank — EXCEPT in this flow, where blank is
    // not a value the wizard can honestly test (see requiredInFlow).
    if (!raw && field?.required === false && !requiredInFlow(key)) continue;
    const message = VALIDATORS[key]?.(raw);
    if (message) errors[key] = message;
  }
  return errors;
}

/**
 * Validates every step at once — the gate the server action runs before it is
 * willing to spend a live connection test. The wizard already validates each
 * step, but the action is a POST endpoint reachable directly, so it re-checks
 * the whole bundle rather than trusting that the client walked the steps.
 */
export function validateWholeFlow(
  integrationId: string,
  values: Readonly<Record<string, string>>,
): FieldErrors {
  const flow = getIntegrationFlow(integrationId);
  if (!flow) return {};
  return flow.steps.reduce<FieldErrors>(
    (acc, step) => Object.assign(acc, validateFlowStep(integrationId, step.id, values)),
    {},
  );
}

/**
 * Which step owns a given field — how a probe's `blameStep` is derived, and how
 * the reauth banner knows where to reopen the flow. Falls back to the verify
 * step, whose meaning ("retry, nothing to edit") is the safe default for a
 * failure we can't attribute to a field.
 */
export function stepOwningField(integrationId: string, key: string): string {
  const flow = getIntegrationFlow(integrationId);
  const step = flow?.steps.find((s) => s.fieldKeys.includes(key));
  return step?.id ?? VERIFY_STEP_ID;
}
