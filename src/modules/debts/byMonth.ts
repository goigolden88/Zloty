/**
 * Закрытое — по годам и месяцам: «когда какие долги были».
 *
 * Закрытые разовые долги и комнаты копятся годами, и одним списком без дат
 * не читаются. Раскладка — по дате самой записи: долг стоит в месяце, когда
 * его взяли или дали, а не когда рассчитались; комната — по дню последнего
 * события. Свежий год и свежий месяц — сверху.
 *
 * Запись без читаемой даты не пропадает: она идёт отдельно, «без даты»,
 * а экран ставит её в конец.
 */

import type { RoomEvent } from '../../app/model.ts'
import { isDateStr } from '../../shared/core/dates.ts'
import { eventsOf } from './balance.ts'

export type MonthGroup<T> = {
  /** `2026-05` */
  month: string
  items: T[]
}

export type YearGroup<T> = {
  /** `2026` */
  year: string
  /** Сколько записей во всех месяцах года. */
  count: number
  months: MonthGroup<T>[]
}

export type ByMonth<T> = {
  years: YearGroup<T>[]
  /** Записи без читаемой даты. */
  undated: T[]
}

/** Записи по годам и месяцам, свежие сверху; внутри месяца — по дате, свежие выше. */
export function byYearMonth<T>(items: readonly T[], dateOf: (item: T) => string | null): ByMonth<T> {
  const dated: { item: T; date: string }[] = []
  const undated: T[] = []
  for (const item of items) {
    const date = dateOf(item)
    if (date !== null && isDateStr(date)) dated.push({ item, date })
    else undated.push(item)
  }
  // Сортировка устойчива: при равной дате порядок входа сохраняется.
  dated.sort((a, b) => b.date.localeCompare(a.date))

  const years: YearGroup<T>[] = []
  for (const { item, date } of dated) {
    const yearKey = date.slice(0, 4)
    const monthKey = date.slice(0, 7)
    let year = years.at(-1)
    if (year?.year !== yearKey) {
      year = { year: yearKey, count: 0, months: [] }
      years.push(year)
    }
    let month = year.months.at(-1)
    if (month?.month !== monthKey) {
      month = { month: monthKey, items: [] }
      year.months.push(month)
    }
    month.items.push(item)
    year.count += 1
  }
  return { years, undated }
}

/** День последнего события комнаты; событий нет — `null`. Удалённые не в счёт. */
export function lastEventDate(events: readonly RoomEvent[], roomId: string): string | null {
  let last: string | null = null
  for (const event of eventsOf(events, roomId)) {
    if (!isDateStr(event.date)) continue
    if (last === null || event.date > last) last = event.date
  }
  return last
}
