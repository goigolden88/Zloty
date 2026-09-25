/**
 * Срез итогов «Злотых» для метаприложения семьи (Р-50; Я-13, Я-16…Я-21 ядра).
 *
 * Форма — ядра (`shared/core/summary.ts`), состав — здесь. Отдаётся только
 * ступень 1 Я-13: внесён ли месяц, по какое число доведены выписки, сколько
 * регулярных ждёт, когда был снимок капитала. Ни сумм, ни долей, ни названий:
 * ступени 2 и 3 не просит ни один потребитель, имена людей не идут никогда
 * (Р-01), названия шаблонов и счетов — тоже (Я-14).
 *
 * Считается только из синхронизируемых записей и дня расчёта: два устройства
 * с одинаковыми данными в один день обязаны дать одинаковый срез (Я-16).
 *
 * Ключи постоянные и не собираются из названий или `id` справочников:
 * по ним метаприложение ставит строки рядом (02 ядра, «Устойчивость ключей»).
 */

import { formatDate, formatMonth, lastDayOf, monthOf, plural } from '../shared/core/dates.ts'
import type { DateStr } from '../shared/core/dates.ts'
import { summaryPeriods, UNKNOWN } from '../shared/core/summary.ts'
import type { Attention, Metric, PeriodSummary, SummaryBody, SummaryPeriod, Unknown } from '../shared/core/summary.ts'
import type { Account, Balance, Category, Entry, Recurring } from '../app/model.ts'
import { recordedThrough } from '../modules/ledger/entries.ts'
import { dueThisMonth, waitingIn } from '../modules/ledger/recurring.ts'
import {
  missingMonth,
  monthRecords,
  RECURRING_FROM_DAY,
  REMIND_FROM_DAY,
  waitingRecurring,
} from '../modules/ledger/remind.ts'

/** Что срезу нужно из данных. Остальные хранилища он не читает. */
export type SliceData = {
  readonly accounts: readonly Account[]
  readonly categories: readonly Category[]
  readonly recurring: readonly Recurring[]
  readonly entries: readonly Entry[]
  readonly balances: readonly Balance[]
}

/** Постоянные ключи среза (Р-50). Меняются только правкой состава договора. */
export const KEYS = {
  records: 'month.records',
  waiting: 'recurring.waiting',
  snapshots: 'capital.snapshots',
  monthMissing: 'month.missing',
  recurringWaiting: 'recurring.waiting',
} as const

/** Свой код «не известно»: выписки не дошли ни до одного дня месяца (Р-50, п. 6). */
export const NOT_LOADED = 'not-loaded'

/** Куда ведёт «требует внимания» — пути хеш-роутинга экранов. */
const LINKS = { import: '/import', entries: '/entries' } as const

const WEEK: Unknown = {
  unknown: UNKNOWN.notProvided,
  text: '«Злотые» считают месяцами: выписки грузятся раз в месяц, и неделя почти всегда ещё не загружена',
}

function operations(n: number): string {
  return `${n} ${plural(n, ['операция', 'операции', 'операций'])}`
}

function totals(n: number): string {
  return `${n} ${plural(n, ['итог периода', 'итога периода', 'итогов периода'])}`
}

function dates(n: number): string {
  return `${n} ${plural(n, ['дату', 'даты', 'дат'])}`
}

function onDay(day: DateStr): string {
  return `на ${formatDate(day)}`
}

/**
 * По какое число верен отрезок месяца и дошли ли до него выписки (Р-50, п. 5–6).
 *
 * `through` — отметка сверки `recordedThrough` (Р-26), обрезанная днём
 * расчёта; у закончившегося месяца, доведённого до конца, — null (Я-21).
 * Выписки кончаются раньше начала месяца — `loaded: false`: ни одного дня
 * месяца в них нет, и число записей было бы неправдой.
 */
type Coverage = {
  through: DateStr | null
  /** Отметка сверки, если есть хоть одна; null — выписок со сверкой нет. */
  recorded: DateStr | null
  loaded: boolean
}

function coverage(period: SummaryPeriod, day: DateStr, recorded: DateStr | null): Coverage {
  const running = period.to >= day
  if (recorded !== null && recorded < period.from) {
    return { through: running ? day : null, recorded, loaded: false }
  }
  if (running) {
    const through = recorded !== null && recorded < day ? recorded : day
    return { through, recorded, loaded: true }
  }
  const through = recorded !== null && recorded < period.to ? recorded : null
  return { through, recorded, loaded: true }
}

function recordsMetric(data: SliceData, period: SummaryPeriod, cover: Coverage, day: DateStr): Metric {
  const label = 'Записей за месяц'
  const { operations: ops, totals: tot } = monthRecords(data.entries, monthOf(period.from))
  const count = ops + tot
  const recorded = cover.recorded

  if (!cover.loaded && recorded !== null) {
    return {
      key: KEYS.records,
      label,
      value: {
        unknown: NOT_LOADED,
        text: `выписки доведены по ${formatDate(recorded)} — ни одного дня этого месяца; записей сейчас ${count}`,
      },
      basis: 'по отметкам сверки выписок: берётся счёт, отставший сильнее всех',
    }
  }

  const what = count === 0 ? 'записей нет' : tot === 0 ? operations(ops) : `${operations(ops)} и ${totals(tot)}`
  const running = period.to >= day
  const through =
    recorded === null
      ? `выписок со сверкой нет — по записям${running ? ` ${onDay(day)}` : ''}`
      : cover.through === null
        ? 'выписки доведены до конца месяца'
        : `выписки доведены по ${formatDate(cover.through)}`
  return { key: KEYS.records, label, value: { n: count, unit: 'count' }, basis: `${what}; ${through}` }
}

function waitingMetric(data: SliceData, period: SummaryPeriod, day: DateStr): Metric {
  const month = monthOf(period.from)
  const due = dueThisMonth(data, month).length
  const left = waitingIn(data, month).length
  const when = period.to >= day ? `; ${onDay(day)}` : ''
  const basis =
    due === 0
      ? `регулярных в этом месяце не ждали${when}`
      : `ждут ${left} из ${due} по шаблонам месяца; внесённой считается запись, отмеченная шаблоном${when}`
  return { key: KEYS.waiting, label: 'Регулярных не внесено', value: { n: left, unit: 'count' }, basis }
}

function snapshotsMetric(data: SliceData, period: SummaryPeriod, day: DateStr): Metric {
  // Снимки от выписок не зависят: идущий месяц — по день расчёта, а не по `through`.
  const end = period.to < day ? period.to : day
  const inPeriod = new Set<DateStr>()
  let last: DateStr | null = null
  for (const balance of data.balances) {
    if (balance.date > end) continue
    if (last === null || balance.date > last) last = balance.date
    if (balance.date >= period.from) inPeriod.add(balance.date)
  }
  const count = inPeriod.size
  const when = period.to >= day ? `; ${onDay(day)}, от выписок не зависит` : ''
  const basis =
    last === null
      ? `снимков капитала нет${when}`
      : count === 0
        ? `в этом месяце снимка нет; последний — ${formatDate(last)}${when}`
        : count === 1
          ? `снимок ${formatDate(last)}${when}`
          : `снимки на ${dates(count)}, последний — ${formatDate(last)}${when}`
  return { key: KEYS.snapshots, label: 'Снимков капитала', value: { n: count, unit: 'count' }, basis }
}

function monthSummary(data: SliceData, period: SummaryPeriod, day: DateStr, recorded: DateStr | null): PeriodSummary {
  const cover = coverage(period, day, recorded)
  return {
    ...period,
    through: cover.through,
    metrics: [
      recordsMetric(data, period, cover, day),
      waitingMetric(data, period, day),
      snapshotsMetric(data, period, day),
    ],
  }
}

/**
 * «Требует внимания» — по правилам своих напоминаний (Р-50, п. 7): когда
 * звать, решает хозяин (Я-21), и второе правило рядом с первым разошлось бы.
 */
function attention(data: SliceData, day: DateStr): Attention[] {
  const items: Attention[] = []

  const missing = missingMonth(data.entries, day)
  if (missing !== null) {
    items.push({
      key: KEYS.monthMissing,
      label: 'Месяц не внесён',
      count: null,
      day: lastDayOf(missing),
      link: LINKS.import,
      basis: `за ${formatMonth(missing)} нет ни одной записи — ни операции, ни итога периода; приложение зовёт с ${REMIND_FROM_DAY}-го числа`,
    })
  }

  const waiting = waitingRecurring(data, day)
  if (waiting.length > 0) {
    const month = monthOf(day)
    items.push({
      key: KEYS.recurringWaiting,
      label: 'Регулярные не внесены',
      count: waiting.length,
      day,
      link: LINKS.entries,
      basis: `${onDay(day)} ждут ${waiting.length} из ${dueThisMonth(data, month).length} по шаблонам месяца; приложение зовёт с ${RECURRING_FROM_DAY}-го числа`,
    })
  }

  return items
}

/** Срез на день расчёта: четыре отрезка ядра и «требует внимания». */
export function summary(data: SliceData, day: DateStr): SummaryBody {
  const recorded = recordedThrough(data.accounts)?.day ?? null
  return {
    periods: summaryPeriods(day).map((period) =>
      period.grain === 'week'
        ? // Идущая неделя не закончилась — `through` у неё день расчёта, а не null (Я-21).
          { ...period, through: period.to >= day ? day : null, metrics: WEEK }
        : monthSummary(data, period, day, recorded),
    ),
    attention: attention(data, day),
  }
}
