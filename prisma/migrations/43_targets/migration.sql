-- Monthly KPI targets
CREATE TABLE "Target" (
    "id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Target_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Target_metric_period_key" ON "Target"("metric", "period");
