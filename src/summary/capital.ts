/**
 * Капитал с долгами (Р-05, Р-39).
 *
 * Капитал = сбережения + вложения − отложенный платёж + мне должны − я должен.
 * Модуль капитала про долги не знает, модуль долгов — про счета; сводит их
 * здесь, как `src/summary/` и задуман. Долги берутся той же функцией, что
 * отчёт месяца (`debtsOn`), — второй раз не считаются.
 *
 * Итог показывается и во второй валюте (`profile.showCurrency`) — по курсу
 * на дату капитала. Курса нет — так и сказано, а не ноль.
 */

import type { CurrencyCode, Money } from '../app/model.ts'
import { capitalDates, capitalOn, changeOf, type Capital, type CapitalData, type Missing } from '../modules/capital/capital.ts'
import type { DebtsData } from '../modules/debts/summary.ts'
import { findCurrency } from '../modules/money/money.ts'
import { convert, type RateLeg } from '../modules/money/rates.ts'
import { debtsOn } from './debts-report.ts'

export type FullCapital = Capital & {
  /** Мне должны и я должен на дату, в базовой валюте. */
  owedToMe: number
  owedByMe: number
  /** Итог с долгами. `total` — без них. */
  net: number
  /** Итог во второй валюте; `null` — второй валюты нет или курса не нашлось. */
  shown: { amount: number; currency: CurrencyCode; legs: readonly RateLeg[] } | null
}

export type FullData = CapitalData & { debts: DebtsData; show?: CurrencyCode }

function toBase(money: Money, day: string, data: FullData, missing: Missing[]): number {
  if (money.amount === 0 || money.currency === data.base) return money.amount
  const from = findCurrency(data.currencies, money.currency)
  const to = findCurrency(data.currencies, data.base)
  const result = from && to ? convert(money, data.base, to.decimals, from.decimals, data.rates, day) : null
  if (!result || 'missing' in result) {
    const was = missing.find((each) => each.currency === money.currency && each.date === day)
    if (was) was.count += 1
    else missing.push({ currency: money.currency, date: day, count: 1 })
    return 0
  }
  return result.money.amount
}

/** Капитал на дату вместе с долгами и итогом во второй валюте. */
export function fullCapitalOn(data: FullData, day: string): FullCapital {
  const capital = capitalOn(data, day)
  const missing = [...capital.missing]
  const debts = debtsOn(data.debts, day)
  const owedToMe = debts.owedToMe.reduce((all, money) => all + toBase(money, day, data, missing), 0)
  const owedByMe = debts.owedByMe.reduce((all, money) => all + toBase(money, day, data, missing), 0)
  const net = capital.total + owedToMe - owedByMe

  let shown: FullCapital['shown'] = null
  if (data.show && data.show !== data.base) {
    const from = findCurrency(data.currencies, data.base)
    const to = findCurrency(data.currencies, data.show)
    const result = from && to ? convert({ amount: net, currency: data.base }, data.show, to.decimals, from.decimals, data.rates, day) : null
    if (result && 'money' in result) shown = { amount: result.money.amount, currency: data.show, legs: result.legs }
  }

  return { ...capital, missing, owedToMe, owedByMe, net, shown }
}

export type CapitalPoint = {
  date: string
  net: number
  /** К прошлой точке, долей; `null` — прошлой нет или делить не на что. */
  change: number | null
  /** Сколько позиций вне итога на эту дату: без курса. */
  missing: number
}

/** Точки капитала от старых к новым — для графика и «% к прошлому» (Р-39). */
export function capitalSeries(data: FullData): CapitalPoint[] {
  let previous: number | null = null
  return capitalDates(data).map((date) => {
    const capital = fullCapitalOn(data, date)
    const point: CapitalPoint = {
      date,
      net: capital.net,
      change: changeOf(capital.net, previous),
      missing: capital.missing.reduce((all, each) => all + each.count, 0),
    }
    previous = capital.net
    return point
  })
}
