-- Saved chatbot flows (library; one active per channel).
CREATE TABLE "BotFlow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "definition" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFlow_pkey" PRIMARY KEY ("id")
);
