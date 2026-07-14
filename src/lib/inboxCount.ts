import "server-only";
import { prisma } from "./db";

const SOCIAL_CHANNELS = ["whatsapp", "messenger", "instagram"];

/**
 * Threads waiting on a reply — social conversations whose most recent message is
 * inbound. Powers the sidebar badge.
 *
 * Reads the maintained Conversation projection (`lastDirection`, kept current on
 * every message) with an indexed COUNT, instead of scanning the last 400 messages
 * and grouping them in JavaScript on every protected navigation.
 */
export async function awaitingReplyCount(): Promise<number> {
  return prisma.conversation.count({
    // Match the inbox list filter (excludes closed) so the badge can't exceed what's shown.
    where: { channel: { in: SOCIAL_CHANNELS }, lastDirection: "inbound", status: { not: "closed" } },
  });
}
