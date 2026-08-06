-- Historic envelopes did not capture the exact resolved merge context, identity
-- policy, release id and custody metadata now required by the trust architecture.
-- A placeholder must never be mistaken for a canonical contract source. Keep all
-- terminal historic records for evidence, but fail every still-open one closed so
-- an operator deliberately reissues it through the hardened preparation path.

UPDATE "SignatureRequest"
SET status='failed_manual_intervention',
    "failureCode"='historic_envelope_requires_secure_reissue',
    "failedAt"=COALESCE("failedAt",now()),
    "completionLeaseOwner"=NULL,
    "completionLeaseExpiresAt"=NULL
WHERE "releaseId"='historic-migration'
  AND status NOT IN ('completed','declined','voided','expired','rejected','failed_manual_intervention');
