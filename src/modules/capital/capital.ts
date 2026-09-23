/**
 * Капитал на дату (Р-05, Р-35, Р-39).
 *
 * Снимок у каждого счёта свой, и капитал на дату собирается из **последнего
 * снимка каждого счёта на эту дату или раньше**. Снимок старше даты в итог
 * входит и называется своей датой — «Jetland — по снимку 31.05»: число
 * остаётся полным, а основание говорит, где оно устарело (Р-39, Р-07).
 * Снимка нет ни одного — счёт назван «без снимка».
 *
 * Отрицательная часть снимка — отложенный платёж: деньги с кредитки, которые
 * лежат на другом счёте (Р-35). «Сбережения» показывают деньги как лежат,
 * без неё; платёж идёт своей строкой и вычитается.
 *
 * Пересчёт в базовую валюту — по курсу на дату капитала: снимок говорит,
 * сколько лежит, а курс — сколько это стоит в тот день. Нет курса — позиция
 * вне итога и названа (Р-04).
 *
 * Долгов модуль не знает: их добавляет `src/summary/capital.ts`.
 */

import type { Account, Balance, Currency, CurrencyCode, Rate } from '../../app/model.ts'
import { findCurrency } from '../money/money.ts'
import { convert, type RateLeg } from '../money/rates.ts'

/** Чего не хватило курса: валюта, дата и по скольким позициям. */
export type Missing = { currency: CurrencyCode; date: string; count: number }

/** Счёт на дату капитала: какой снимок взят и сколько он стоит в базовой валюте. */
export type Holding = {
  account: Account
  /** Дата взятого снимка; раньше даты капитала — снимок устарел и называется. */
  date: string
  /** Части снимка, как записаны: без части — одна строка с `part` undefined. */
  parts: { part?: string; amount: number }[]
  /** Сколько лежит — сумма неотрицательных частей, в валюте счёта. */
  held: number
  /** Сколько к возврату — отрицательные части, числом больше нуля, в валюте счёта. */
  deferred: number
  /** То же в базовой валюте; `null` — курса не нашлось. */
  heldBase: number | null
  deferredBase: number | null
  /** Каким курсом пересчитано: пусто, если валюта базовая. */
  legs: readonly RateLeg[]
  /** На одну дату записаны и снимок без части, и части — Р-12 так не велит; взяты части. */
  mixed: boolean
}

export type CapitalData = {
  accounts: readonly Account[]
  balances: readonly Balance[]
  rates: readonly Rate[]
  currencies: readonly Currency[]
  base: CurrencyCode
}

export type Capital = {
  date: string
  /** Сбережения — деньги как лежат, в базовой валюте. */
  savings: number
  /** Вложения, в базовой валюте. */
  investments: number
  /** Отложенный платёж — к возврату, числом больше нуля, в базовой валюте. */
  deferred: number
  /** Сбережения + вложения − отложенный платёж. Долги добавляет сводка. */
  total: number
  holdings: Holding[]
  /** Счета, у которых снимка на эту дату или раньше нет ни одного. */
  without: Account[]
  missing: Missing[]
}

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

/**
 * Счета, из которых складывается капитал: живые, кроме счетов истории.
 * Счёт истории (`ledgerOnly`) держит итоги прежней таблицы, денег на нём нет.
 * Архивный счёт остаётся: его прошлые снимки — часть прошлого капитала.
 */
export function capitalAccounts(accounts: readonly Account[]): Account[] {
  return live(accounts).filter((account) => !account.ledgerOnly)
}

/** Снимок счёта на дату: последняя дата не позже `day` и все записи этой даты. */
export function latestOf(balances: readonly Balance[], accountId: string, day: string): Balance[] {
  let date = ''
  for (const each of balances) {
    if (each.deleted || each.accountId !== accountId || each.date > day) continue
    if (each.date > date) date = each.date
  }
  if (!date) return []
  return balances.filter((each) => !each.deleted && each.accountId === accountId && each.date === date)
}

/** Капитал на дату — без долгов. */
export function capitalOn(data: CapitalData, day: string): Capital {
  const missing = new Map<string, Missing>()
  const holdings: Holding[] = []
  const without: Account[] = []

  const lack = (currency: CurrencyCode) => {
    const key = `${currency}:${day}`
    const was = missing.get(key)
    if (was) was.count += 1
    else missing.set(key, { currency, date: day, count: 1 })
    return { amount: null, legs: [] }
  }

  const toBase = (amount: number, currency: CurrencyCode): { amount: number | null; legs: readonly RateLeg[] } => {
    if (amount === 0 || currency === data.base) return { amount, legs: [] }
    // Валюты нет в справочнике — нет и знаков после запятой: считать не по чему.
    const from = findCurrency(data.currencies, currency)
    const to = findCurrency(data.currencies, data.base)
    if (!from || !to) return lack(currency)
    const result = convert({ amount, currency }, data.base, to.decimals, from.decimals, data.rates, day)
    if ('missing' in result) return lack(currency)
    return { amount: result.money.amount, legs: result.legs }
  }

  for (const account of capitalAccounts(data.accounts)) {
    const found = latestOf(data.balances, account.id, day)
    const first = found[0]
    if (!first) {
      without.push(account)
      continue
    }

    const named = found.filter((each) => each.part !== undefined)
    const mixed = named.length > 0 && named.length < found.length
    const used = named.length > 0 ? named : found

    let held = 0
    let deferred = 0
    for (const each of used) {
      if (each.amount < 0) deferred += -each.amount
      else held += each.amount
    }

    const heldBase = toBase(held, account.currency)
    const deferredBase = toBase(deferred, account.currency)
    holdings.push({
      account,
      date: first.date,
      parts: used.map((each) => (each.part === undefined ? { amount: each.amount } : { part: each.part, amount: each.amount })),
      held,
      deferred,
      heldBase: heldBase.amount,
      deferredBase: deferredBase.amount,
      legs: heldBase.legs.length > 0 ? heldBase.legs : deferredBase.legs,
      mixed,
    })
  }

  let savings = 0
  let investments = 0
  let deferred = 0
  for (const each of holdings) {
    if (each.heldBase !== null) {
      if (each.account.kind === 'investment') investments += each.heldBase
      else savings += each.heldBase
    }
    if (each.deferredBase !== null) deferred += each.deferredBase
  }

  return {
    date: day,
    savings,
    investments,
    deferred,
    total: savings + investments - deferred,
    holdings,
    without,
    missing: [...missing.values()],
  }
}

/** Устаревшие позиции: снимок взят с более ранней даты. */
export function staleOf(capital: Capital): Holding[] {
  return capital.holdings.filter((each) => each.date < capital.date)
}

/**
 * Точки капитала — даты, на которые внесён хоть один снимок (Р-39).
 * По ним строится график и «% к прошлому». От старых к новым.
 */
export function capitalDates(data: Pick<CapitalData, 'accounts' | 'balances'>): string[] {
  const ids = new Set(capitalAccounts(data.accounts).map((account) => account.id))
  const dates = new Set<string>()
  for (const each of data.balances) {
    if (!each.deleted && ids.has(each.accountId)) dates.add(each.date)
  }
  return [...dates].sort()
}

/**
 * Изменение к прошлой точке, долей: 0.05 — «+5%».
 * Прошлого нет или он не больше нуля — доли нет: делить не на что.
 */
export function changeOf(total: number, previous: number | null): number | null {
  if (previous === null || !(previous > 0)) return null
  return (total - previous) / previous
}
