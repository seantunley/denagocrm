-- Chatbot flow session state (per conversation).
CREATE TABLE "BotSession" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "key" TEXT NOT NULL,
    "nodeId" TEXT,
    "vars" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BotSession_channel_key_key" ON "BotSession"("channel", "key");
