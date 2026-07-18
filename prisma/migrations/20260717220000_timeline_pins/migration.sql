CREATE TABLE "TimelinePin" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pinnedById" TEXT NOT NULL,

  CONSTRAINT "TimelinePin_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimelinePin_kind_check" CHECK ("kind" IN ('communication', 'activity')),
  CONSTRAINT "TimelinePin_pinnedById_fkey"
    FOREIGN KEY ("pinnedById") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TimelinePin_kind_itemId_key"
  ON "TimelinePin"("kind", "itemId");

CREATE INDEX "TimelinePin_pinnedAt_idx"
  ON "TimelinePin"("pinnedAt");
