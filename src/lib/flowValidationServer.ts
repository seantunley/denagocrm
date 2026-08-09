import { getSetting } from "./settings";
import type { FlowChannel } from "./flowValidation";

/** Channels on which the shared published journey can actually run right now. */
export async function enabledFlowChannels(): Promise<FlowChannel[]> {
  const [dmEnabled, telegramEnabled] = await Promise.all([
    getSetting("BOT_DM_ENABLED"),
    getSetting("BOT_TG_ENABLED"),
  ]);
  const channels: FlowChannel[] = ["whatsapp"];
  if (dmEnabled === "true") channels.push("messenger", "instagram");
  if (telegramEnabled === "true") channels.push("telegram");
  return channels;
}
