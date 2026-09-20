/**
 * Курсы и пересчёт (Р-04).
 *
 * Пересчёт не хранится — он считается. Курс берётся **на дату события**:
 * у операции — на дату операции, у снимка — на дату снимка. Это отвечает
 * на вопрос «сколько это стоило тогда», а не «сколько бы стоило сегодня».
 *
 * Курса на дату нет — берём ближайший более ранний, но не старше
 * `RATE_MAX_AGE_DAYS`. Нет и такого — позиция **не входит в итог и
 * называется**: «1 240 000 ₽ по 5 из 6 позиций: нет курса EUR на 12.09»
 * (Р-04, Р-07).
 */

import { daysBetween } from '../../shared/core/dates.ts'
import type { CurrencyCode, Money, Rate } from '../../app/model.ts'

/**
 * Насколько старый курс ещё годится. Месяц — потому что курс вносится руками
 * и импортом, а снимки капитала человек делает примерно раз в месяц.
 * Число видно в справке и в основании итогов, поэтому живёт константой.
 */
export const RATE_MAX_AGE_DAYS = 31

/** Найденный курс и его основание: на ту ли дату он и откуда взят. */
export type FoundRate = {
  rate: number
  /** Дата самого курса — она же основание: «по курсу на 12.09». */
  date: string
  /** Совпала ли дата курса с датой события. */
  exact: boolean
  /** Курс был записан в обратную сторону и перевёрнут. */
  inverted: boolean
}

/**
 * Курс `from` → `to` на дату.
 *
 * Годится и запись в обратную сторону: курс USD→RUB отвечает на вопрос
 * RUB→USD делением. Второй раз то же самое человеком не вносится.
 */
export function findRate(
  rates: readonly Rate[],
  from: CurrencyCode,
  to: CurrencyCode,
  onDate: string,
  maxAgeDays: number = RATE_MAX_AGE_DAYS,
): FoundRate | null {
  if (from === to) return { rate: 1, date: onDate, exact: true, inverted: false }

  let best: FoundRate | null = null
  for (const record of rates) {
    if (record.date > onDate) continue

    const straight = record.from === from && record.to === to
    const inverted = record.from === to && record.to === from
    if (!straight && !inverted) continue
    if (inverted && !(record.rate > 0)) continue

    const age = daysBetween(record.date, onDate)
    if (age > maxAgeDays) continue
    if (best && best.date >= record.date) continue

    best = {
      rate: straight ? record.rate : 1 / record.rate,
      date: record.date,
      exact: record.date === onDate,
      inverted: !straight,
    }
  }
  return best
}

/** Пересчёт удался — или не удался, и тогда известно, какого курса не хватило. */
export type Converted =
  | { money: Money; basis: FoundRate }
  | { missing: { from: CurrencyCode; to: CurrencyCode; date: string } }

/**
 * Пересчитать сумму в другую валюту по курсу на дату.
 *
 * Результат округляется здесь и нигде не хранится: поправите курс —
 * поменяется и число, второго источника правды не заводится (Р-04).
 */
export function convert(
  money: Money,
  to: CurrencyCode,
  toDecimals: number,
  fromDecimals: number,
  rates: readonly Rate[],
  onDate: string,
  maxAgeDays: number = RATE_MAX_AGE_DAYS,
): Converted {
  const found = findRate(rates, money.currency, to, onDate, maxAgeDays)
  if (!found) return { missing: { from: money.currency, to, date: onDate } }

  const major = money.amount / 10 ** fromDecimals
  const amount = Math.round(major * found.rate * 10 ** toDecimals)
  return { money: { amount, currency: to }, basis: found }
}
