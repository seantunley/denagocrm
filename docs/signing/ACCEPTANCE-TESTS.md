# Mandatory signing acceptance tests

These tests are deployment gates, not optional QA. Automate them where possible and retain evidence from every staging and production-readiness run.

## Custody and commit ambiguity

- Simulate loss of the database commit acknowledgement after signed-artifact registration. The object remains, the envelope reconciles, and no duplicate legal artifact is created.
- Repeat for unsigned-envelope creation. The source PDF remains available.
- Roll back after Blob upload. The object enters delayed orphan settlement and is not synchronously deleted.
- Remove or corrupt an active object. Reconciliation raises an operator-visible integrity failure and never reports healthy completion.

## Durable orchestration

- Crash immediately after recipient signature commit. The trigger-created outbox job advances the workflow.
- Crash after final storage but before response. Retry resumes without duplicate sealing, delivery or deletion.
- Run two workers against the same jobs. Leases and idempotency prevent duplicate external effects.
- Make SMTP/SMS unavailable. Per-recipient failure is visible, retried and eventually dead-lettered.
- Confirm `completed` is impossible until reconciliation, post-completion work, all required deliveries and the final external evidence anchor have succeeded.

## Tenant isolation

- Execute complete signing, approval, evidence-download, outbox, cron, storage and recovery journeys with two tenants.
- Present tenant A tokens while scoped to tenant B. Access is denied.
- Remove tenant scope from a signing business path under enforcement. It fails closed.
- Verify forced RLS with a NOSUPERUSER/NOBYPASSRLS database role.

## Identity and public surface

- Verify ES1, email OTP, SMS OTP, dual OTP, authenticated portal and passkey policies.
- Forward a link without the second factor. Signing is denied.
- Verify OTP expiry, lockout, replay rejection and destination binding.
- Verify passkey user-verification requirement, tenant/email ownership and signature-counter update.
- Verify closed, declined, rejected, voided, expired and revoked links reveal no document.
- Confirm raw recipient/approval tokens never appear in normal client state or database storage.

## Cryptography and evidence

- Remove the trust-service configuration in production. Startup/sealing fails.
- Return a seal without RFC 3161 timestamp or a valid independent validation report. Completion fails.
- Verify certificate fingerprint, chain, key version, policy, timestamp and validation report are retained.
- Recheck a historic artifact after certificate expiry/revocation using retained LTV evidence.
- Mutate or delete a SignatureEvent directly. The database refuses it.
- Verify every event hash and the external anchor root.
- Export and independently verify the portable evidence bundle without the live CRM.

## Privacy, retention and recovery

- Attempt Trash, purge and direct deletion of a completed artifact. All are refused.
- Verify legal hold prevents destruction.
- Verify requester and approver must differ and destruction emits a permanent certificate.
- Restore a full backup into an isolated environment, run `npx tsx scripts/verify-signing-restore.ts`, verify every legal-artifact hash and timestamp object, and complete an evidence export.
- Change the live quote/job card after dispatch. The final PDF remains based only on the frozen canonical package.
- Perform a runtime penetration test, cloud/storage configuration audit, load test and documented disaster-recovery exercise.
