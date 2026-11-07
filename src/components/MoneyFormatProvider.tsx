"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_REGIONAL, type MoneyFormat } from "@/lib/format";

/**
 * The workspace's money format (currency + locale) for components in the browser,
 * which cannot read settings. Set once by AppShell from the (app) layout; anything
 * outside it gets the rand, which is what everything showed before.
 */
const MoneyFormatContext = createContext<MoneyFormat>(DEFAULT_REGIONAL);

export function MoneyFormatProvider({ money, children }: { money: MoneyFormat; children: ReactNode }) {
  return <MoneyFormatContext.Provider value={money}>{children}</MoneyFormatContext.Provider>;
}

export function useMoneyFormat(): MoneyFormat {
  return useContext(MoneyFormatContext);
}
