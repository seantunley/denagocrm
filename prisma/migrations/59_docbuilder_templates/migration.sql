-- Block-based document builder templates (Puck tree → react-pdf). Additive.
CREATE TABLE "DocBuilderTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "DocBuilderTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocBuilderTemplate_key_isDefault_idx" ON "DocBuilderTemplate"("key", "isDefault");
