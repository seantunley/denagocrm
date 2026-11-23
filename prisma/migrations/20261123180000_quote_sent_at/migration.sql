-- When a quote was first sent. Set by the database the first time its status becomes sent or accepted, whichever
-- code path does it (editor, email send, signing, DAX…), and never moved after — so "sent in the last 7 days" means
-- that, not "drafted in the last 7 days". Additive.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);

-- The backfill crosses every workspace: lift RLS for this migration's own session.
SET app.bypass_rls = 'on';

-- Quotes already out: the earliest evidence that they left (emailed, signing link, signed), else their creation. An
-- estimate for history only. A cancelled quote counts only with that evidence (one may never have been sent).
UPDATE "Quote"
   SET "sentAt" = COALESCE(LEAST("emailedAt", "signLinkCreatedAt", "signedAt"), "createdAt")
 WHERE "sentAt" IS NULL
   AND (
     "status" IN ('sent', 'accepted', 'declined')
     OR ("status" = 'cancelled' AND COALESCE("emailedAt", "signLinkCreatedAt", "signedAt") IS NOT NULL)
   );

CREATE OR REPLACE FUNCTION "Quote_stamp_sent_at"() RETURNS trigger AS $$
BEGIN
  IF NEW."sentAt" IS NULL AND NEW."status" IN ('sent', 'accepted') THEN
    NEW."sentAt" := now();
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."sentAt" IS NOT NULL THEN
    NEW."sentAt" := OLD."sentAt";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Quote_stamp_sent_at" ON "Quote";
CREATE TRIGGER "Quote_stamp_sent_at"
  BEFORE INSERT OR UPDATE ON "Quote"
  FOR EACH ROW EXECUTE FUNCTION "Quote_stamp_sent_at"();
