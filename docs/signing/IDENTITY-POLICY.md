# Signing identity policy

Identity assurance is selected per template or transaction. The chosen method, result, transaction identifier and assurance level are sealed into the evidence package.

| Policy | Intended use | Controls |
|---|---|---|
| `ES1_LINK` | Low-risk acknowledgement | Personal high-entropy link, consent, name, IP/device evidence. Never the production default. |
| `ES2_EMAIL_OTP` | Ordinary quotes/contracts | Link plus one-time code to the confirmed email address. |
| `ES2_SMS_OTP` | Ordinary quotes/contracts | Link plus OTP through the configured real SMS provider. WhatsApp is not silently represented as SMS. |
| `ES2_EMAIL_SMS` | Higher-risk ordinary contract | Independent email and SMS factors in the same signing session. |
| `ES2_AUTHENTICATED_PORTAL` | Known customer/staff account | Active CRM session whose tenant and normalized email match the intended recipient. |
| `ES3_PASSKEY` | High-value/disputed transaction | Registered passkey belonging to the matched tenant account, mandatory WebAuthn user verification, replay counter update. |
| `ES3_IDENTITY_PROVIDER` | High assurance requiring external KYC/liveness | Delegated external ceremony; fail closed until configured. |
| `AES_ACCREDITED` | Use case requiring advanced electronic signature | Accredited South African process and legal approval. The CRM does not emulate or self-claim accreditation. |

OTP secrets are HMAC protected, expire after ten minutes, lock after repeated failures, and are tied to recipient and envelope. Identity sessions are signed, HTTP-only, same-site and short-lived. Public bearer tokens are never stored in plaintext.

The SMS service contract is `POST {to,text,idempotencyKey}` with bearer authentication and response `{ok,messageId,error}`. Configure `SIGNING_SMS_SERVICE_URL` and `SIGNING_SMS_SERVICE_TOKEN` before selecting an SMS policy.
