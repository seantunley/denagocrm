-- Research history: one row per research run (the record's research column
-- keeps the latest snapshot for quick access / kanban).
CREATE TABLE "ResearchNote" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leadId" TEXT,
    "contactId" TEXT,
    CONSTRAINT "ResearchNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResearchNote_leadId_idx" ON "ResearchNote"("leadId");
CREATE INDEX "ResearchNote_contactId_idx" ON "ResearchNote"("contactId");
ALTER TABLE "ResearchNote" ADD CONSTRAINT "ResearchNote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchNote" ADD CONSTRAINT "ResearchNote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
