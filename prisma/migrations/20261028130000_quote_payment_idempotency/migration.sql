-- Customer statements, review of #924: a payment submitted twice — a retry after
-- a dropped connection, a double click — must be recorded ONCE. Every payment
-- form carries a one-time key; the second submission finds the first payment by
-- it and returns that instead of writing another. The unique index is the
-- backstop if two arrive at once. NULL is allowed only so this can be added to
-- the table as already created; every payment the app writes carries a key.
-- Additive only; re-runnable.

ALTER TABLE "QuotePayment" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "QuotePayment_tenantId_idempotencyKey_key" ON "QuotePayment"("tenantId", "idempotencyKey");
