/**
 * The social-inbox channels. Pure and DB-free so the validation used by the
 * thread-mutating server actions (which feed a client-supplied `channel`
 * straight into a bulk updateMany) can be unit-tested in isolation.
 */
export const SOCIAL_CHANNELS = ["whatsapp", "messenger", "instagram"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

export function isSocialChannel(channel: string): channel is SocialChannel {
  return (SOCIAL_CHANNELS as readonly string[]).includes(channel);
}
