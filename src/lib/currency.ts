import "server-only";
import { cache } from "react";
import { getRegionalSettings, getSetting } from "./settings";
import { isModuleEnabled } from "./modules/enabled";
import { parseEnabledCurrencies } from "./currencyRules";

/** AppSetting key: CSV of the extra currencies an owner offers (Settings → Quotes). */
export const ENABLED_CURRENCIES_KEY = "ENABLED_CURRENCIES";

export type CurrencyOptions = {
  /** The workspace's base currency (Regional.currency). */
  base: string;
  /** Base first, then the extras — only when the module is on; otherwise just the base. */
  enabled: string[];
  /** Whether the `multicurrency` module is on for this workspace. */
  on: boolean;
};

/**
 * The currencies this workspace may use, once per server render. With the module off
 * this is always the base alone, so no picker appears and nothing new can be written.
 */
export const getCurrencyOptions = cache(async (): Promise<CurrencyOptions> => {
  const [regional, on] = await Promise.all([getRegionalSettings(), isModuleEnabled("multicurrency").catch(() => false)]);
  if (!on) return { base: regional.currency, enabled: [regional.currency], on: false };
  return { base: regional.currency, enabled: parseEnabledCurrencies(await getSetting(ENABLED_CURRENCIES_KEY), regional.currency), on: true };
});
