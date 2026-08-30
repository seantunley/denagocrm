export const BOT_ANALYTICS_RANGES = [7, 30, 90] as const;
export type BotAnalyticsRangeDays = (typeof BOT_ANALYTICS_RANGES)[number];

export const BOT_ANALYTICS_CHANNELS = ["whatsapp", "messenger", "instagram", "telegram"] as const;
export type BotAnalyticsChannel = (typeof BOT_ANALYTICS_CHANNELS)[number];

export type BotAnalyticsFilterInput = {
  range?: string;
  channel?: string;
  version?: string;
};

export type BotAnalyticsFilters = {
  rangeDays: BotAnalyticsRangeDays;
  channel: BotAnalyticsChannel | null;
  versionId: string | null;
  occurredFrom: Date;
};

export function analyticsOccurredFrom(rangeDays: BotAnalyticsRangeDays, now = new Date()): Date {
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - rangeDays + 1);
  return from;
}

export function normalizeBotAnalyticsFilters(
  input: BotAnalyticsFilterInput,
  validVersionIds: string[],
  now = new Date(),
): BotAnalyticsFilters {
  const requestedRange = Number(input.range);
  const rangeDays = BOT_ANALYTICS_RANGES.includes(requestedRange as BotAnalyticsRangeDays)
    ? requestedRange as BotAnalyticsRangeDays
    : 30;
  const channel = BOT_ANALYTICS_CHANNELS.includes(input.channel as BotAnalyticsChannel)
    ? input.channel as BotAnalyticsChannel
    : null;
  const versionId = input.version && validVersionIds.includes(input.version)
    ? input.version
    : validVersionIds[0] ?? null;

  return {
    rangeDays,
    channel,
    versionId,
    occurredFrom: analyticsOccurredFrom(rangeDays, now),
  };
}

