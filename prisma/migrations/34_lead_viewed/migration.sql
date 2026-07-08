-- Track when a lead was first opened (for the "NEW" pill on the board).
ALTER TABLE "Lead" ADD COLUMN "viewedAt" TIMESTAMP(3);
