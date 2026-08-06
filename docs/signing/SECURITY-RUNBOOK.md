# Production security and operations runbook

## Mandatory configuration

Production startup fails unless all required trust controls are present:

- `BLOB_PRIVATE=true` and `BLOB_PRIVATE_READ_WRITE_TOKEN`
- `TENANT_ENFORCEMENT=enforce`
- 32-byte `SIGNING_TOKEN_ENCRYPTION_KEY`
- independent `SIGNING_IDENTITY_SESSION_SECRET`
- `SIGNING_TRUST_SERVICE_URL` and `SIGNING_TRUST_SERVICE_TOKEN`
- `SIGNING_ANCHOR_URL` and `SIGNING_ANCHOR_TOKEN`
- `SIGNING_RELEASE_ID` or `VERCEL_GIT_COMMIT_SHA`
- real SMS provider credentials when an SMS policy is the default
- `CRON_SECRET` for outbox and reconciliation routes

Startup performs a private-store write/read/delete self-test. Production does not fall back to public Blob or local disk. The trust service and evidence anchor are fail-closed.

## Deployment sequence

1. Take and verify a full database and asset backup.
2. Review unresolved tenant ownership; the migration refuses any signing row it cannot assign authoritatively.
3. Apply the trust-architecture migration during a controlled window.
4. Run `npx tsx scripts/reconcile-signing-artifacts.ts 5000`.
5. Confirm `/settings/signing` has no dead letters, missing artifacts or historic validation alerts.
6. Verify the one-minute signing outbox cron and daily reconciliation cron are running.
7. Execute the acceptance suite in `ACCEPTANCE-TESTS.md` against staging.
8. Perform the external penetration test and disaster-recovery exercise before unrestricted production use.

Historic open envelopes without a frozen canonical source are marked `failed_manual_intervention` and must be reissued. Historic completed artifacts are not assigned fabricated certificate evidence; they remain protected and are explicitly flagged for validation/migration.

## Operations

- Retry durable jobs only from the trust-operations screen; every manual recovery is recorded.
- A dead-letter dependency prevents final `completed` state and moves the envelope to manual intervention.
- Reconciliation verifies object existence, SHA-256 and legal-ledger consistency.
- Place legal hold before a dispute or investigation. Releasing a hold does not bypass retention.
- Destruction requires a requester, a different approver, elapsed retention, no hold, execution, and a permanent certificate.
- Monitor certificate expiry/revocation, anchor-service availability, outbox age, dead letters, failed deliveries, missing objects and restore verification.

## Incident response

Immediately revoke affected signing tokens, suspend dispatch, preserve the evidence and object stores, place legal holds where appropriate, export portable evidence bundles, record every recovery action, and follow the POPIA breach process. Never delete an uncertain object as a compensating action.
