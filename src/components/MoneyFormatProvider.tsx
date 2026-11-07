"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_REGIONAL, type MoneyFormat } from "@/lib/format";

/**
 * The workspace's money format (currency + locale) for components in the browser,
 * which cannot read settings. Set once by AppShell from the (app) layout; anything
 * outside it gets the rand, which is what everything showed before.
 *
 * Also the currencies a lead or quote may be in (multicurrency module): the base
 * first, then the extras an owner ticked. One entry means no picker is shown.
 */
type MoneyContext = { money: MoneyFormat; currencies: readonly string[] };

const MoneyFormatContext = createContext<MoneyContext>({ money: DEFAULT_REGIONAL, currencies: [DEFAULT_REGIONAL.currency] });

export function MoneyFormatProvider({
  money,
  currencies,
  children,
}: {
  money: MoneyFormat;
  currencies?: readonly string[];
  children: ReactNode;
}) {
  return (
    <MoneyFormatContext.Provider value={{ money, currencies: currencies?.length ? currencies : [money.currency] }}>
      {children}
    </MoneyFormatContext.Provider>
  );
}

export function useMoneyFormat(): MoneyFormat {
  return useContext(MoneyFormatContext).money;
}

/** The currencies a record may be in, base first. Length 1 = multi-currency is off: show no picker. */
export function useCurrencies(): readonly string[] {
  return useContext(MoneyFormatContext).currencies;
}
