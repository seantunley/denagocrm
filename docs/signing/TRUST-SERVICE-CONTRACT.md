# Signing trust service contract

Production sealing is remote and fail-closed. Configure `SIGNING_TRUST_SERVICE_URL` and `SIGNING_TRUST_SERVICE_TOKEN`.

## Request

`POST` JSON:

```json
{
  "pdfBase64": "...",
  "metadata": {
    "reason": "Signed: Agreement title",
    "name": "Denago Cape Town",
    "location": "Cape Town, ZA",
    "contactInfo": "sales@denagocpt.co.za"
  },
  "requestedProfile": "PAdES-B-LT",
  "requireTrustedTimestamp": true,
  "requireIndependentValidation": true
}
```

The service authenticates the tenant/platform policy, performs the private-key operation inside HSM/KMS or an equivalent dedicated trust boundary, obtains an RFC 3161 timestamp, embeds revocation material appropriate to the requested PAdES profile, independently validates the completed PDF, and returns only the artifact and evidence.

## Response

```json
{
  "sealedPdfBase64": "...",
  "certificateFingerprint": "sha256-hex",
  "certificateChainPem": ["-----BEGIN CERTIFICATE-----..."],
  "keyId": "kms-key-version",
  "trustPolicy": "denago-platform-seal-v1",
  "timestampTokenBase64": "...",
  "validationReport": {
    "valid": true,
    "profile": "PAdES-B-LT",
    "checkedAt": "2026-08-06T00:00:00.000Z",
    "details": {}
  }
}
```

The CRM rejects a missing timestamp, invalid validation report, absent fingerprint, non-PDF output, non-2xx response, timeout, or unavailable service. The service must be idempotent for the same artifact digest and policy, preserve auditable key-version history, expose certificate expiry/revocation monitoring, and support controlled rotation without invalidating historic evidence.

PAdES-B-LTA may be selected for records whose retention and validation horizon requires periodic timestamp renewal.
