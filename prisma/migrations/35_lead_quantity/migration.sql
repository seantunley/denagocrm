-- Number of carts a lead wants (drives the deal value).
ALTER TABLE "Lead" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
