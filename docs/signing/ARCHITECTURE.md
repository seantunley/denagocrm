# Denago high-trust signing architecture

This module implements a tenant-bound electronic-signature and evidence platform. It is not represented as an accredited South African advanced electronic signature service unless a separately accredited ceremony is selected and approved for the use case.

## Envelope state machine

`draft → prepared → dispatching → active → signing → signatures_complete → rendering → sealed → distributing → completed`

Terminal states are `declined`, `rejected`, `voided`, `expired`, and `failed_manual_intervention`.

A signature commit creates durable outbox work in the same database transaction. Completion leases the envelope, renders only from the frozen document and canonical source context, creates a private stored object, seals it through the trust boundary, records an immutable legal artifact, and enters `sealed`. Database triggers enqueue reconciliation, per-recipient delivery, post-completion work, and finalization. The finalizer waits until all dependencies have completed, appends the final `completed` evidence event, anchors that event root outside the operational database, and only then exposes `completed`.

## Trust boundaries

- **Tenant boundary:** every signing, evidence, delivery, job and artifact row has a non-null tenant ID; composite foreign keys and forced PostgreSQL RLS prevent cross-tenant relationships and access.
- **Signer boundary:** public links are high-entropy capabilities stored only as SHA-256 digests. Recoverable delivery copies are AES-256-GCM encrypted.
- **Identity boundary:** templates select link, email OTP, SMS OTP, email-and-SMS, authenticated portal, passkey, external identity provider, or accredited signing ceremony.
- **Storage boundary:** production starts only with private durable Blob storage. Local and public fallback are disabled.
- **Cryptographic boundary:** production uses a remote trust service/HSM contract. The CRM runtime never receives the long-term private key.
- **Evidence boundary:** signature events are database-enforced append-only, sequence-numbered and hash-chained. Final roots are externally anchored.
- **Custody boundary:** completed artifacts live in `LegalArtifact`, outside normal Trash and purge. Destruction requires elapsed retention, no legal hold, two different operators, and a permanent destruction certificate.

## Failure semantics

Database errors are not proof of rollback. Uploaded objects are retained unless an authoritative, tenant-aware reference inventory proves they are unused. Orphans are settled asynchronously only after a delay. External side effects use durable leases, idempotency keys, exponential retries and dead-letter escalation.

## Portable evidence bundle

The export contains the sealed PDF, manifest, recipients and assurance methods, placed-field answers, full hash-chained event ledger, delivery records, recovery actions, certificate chain, validation report, trusted timestamp reference, and external evidence anchors. It is designed for verification without the live CRM database.
