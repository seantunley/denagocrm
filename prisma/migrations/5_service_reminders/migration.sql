-- CreateTable
CREATE TABLE "ServiceReminderLog" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "dueKey" TEXT NOT NULL,
    "sentTo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceReminderLog_vehicleId_dueKey_key" ON "ServiceReminderLog"("vehicleId", "dueKey");

