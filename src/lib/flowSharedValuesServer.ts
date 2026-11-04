import "server-only";
import { getSetting } from "./settings";
import { FLOW_SHARED_VALUES_KEY, parseSharedValues, sharedVars } from "./flowSharedValues";

/** This workspace's shared values as flow variables — the current scope's own (getSetting is workspace-scoped). */
export async function flowSharedVars(): Promise<Record<string, string>> {
  return sharedVars(parseSharedValues(await getSetting(FLOW_SHARED_VALUES_KEY).catch(() => null)));
}
