/**
 * О чём напоминать (План, Этап 1, п. 9).
 *
 * Чистые функции, без React, без `db` и без уведомлений: механика окна,
 * звука и разрешений — ядра (`shared/notify.ts`), здесь только правило
 * «есть ли о чём говорить» и текст.
 *
 * Напоминаний два, и они про разное:
 *
 * — **«Внести месяц»** — за прошлый месяц не загружено ни одной записи.
 *   Это главная петля приложения: месяц, который не внесён, не отвечает
 *   на вопрос «сколько я отложил»;
 * — **«Регулярные»** — этого месяца ждут платежи, которых ещё нет.
 *
 * Оба молчат, пока молчать честно: напоминание, которое приходит всегда,
 * перестают читать.
 */

import { formatMonth } from '../../shared/core/dates.ts'
import type { Entry } from '../../app/model.ts'
import { waitingIn, type Due, type RecurringData } from './recurring.ts'

/**
 * С какого числа напоминать о прошлом месяце.
 *
 * Не с первого: банки формируют выписку не мгновенно, а операции последних
 * чисел доходят с задержкой. Напоминание первого числа пришло бы раньше,
 * чем появилось бы что загружать.
 */
export const REMIND_FROM_DAY = 3

/** С какого числа напоминать о регулярных этого месяца. */
export const RECURRING_FROM_DAY = 10

/** Текст уведомления — или null, если напоминать не о чем. */
export type Notice = { title: string; body: string } | null

function monthOf(day: string): string {
  return day.slice(0, 7)
}

function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const number = Number(month.slice(5, 7))
  return number > 1 ? `${year}-${String(number - 1).padStart(2, '0')}` : `${year - 1}-12`
}

function dayNumber(day: string): number {
  return Number(day.slice(8, 10))
}

/** Сколько живых записей за месяц: операций — по дате, итогов — накрывающих его. */
export type MonthRecords = { operations: number; totals: number }

/**
 * Записи месяца — операции с датой в нём и итоги периода, которые его
 * накрывают хоть одним днём. Итог периода закрывает месяц, который он
 * накрывает: вносить его второй раз не нужно (Р-12, п. 6).
 */
export function monthRecords(entries: readonly Entry[], month: string): MonthRecords {
  let operations = 0
  let totals = 0
  for (const each of entries) {
    if (each.deleted) continue
    if (each.date?.startsWith(`${month}-`)) operations += 1
    else if (each.period !== undefined && each.period.from <= `${month}-31` && `${month}-01` <= each.period.to) totals += 1
  }
  return { operations, totals }
}

/** Есть ли хоть одна живая запись за этот месяц — операцией или итогом. */
export function monthHasEntries(entries: readonly Entry[], month: string): boolean {
  const { operations, totals } = monthRecords(entries, month)
  return operations + totals > 0
}

/**
 * За какой месяц пора звать «внести месяц» — или null. Правило одно
 * на напоминание и на срез итогов (Р-50): второе рядом разошлось бы молча.
 * Молчит, если месяц уже внесён, если сегодня слишком рано или если записей
 * нет вовсе — новому человеку напоминать не о чем, ему показывают приветствие.
 */
export function missingMonth(entries: readonly Entry[], day: string): string | null {
  if (dayNumber(day) < REMIND_FROM_DAY) return null
  if (entries.every((each) => each.deleted)) return null

  const past = previousMonth(monthOf(day))
  return monthHasEntries(entries, past) ? null : past
}

/**
 * Регулярные идущего месяца, о которых пора звать: ждут и ещё не внесены.
 * Пусто — звать рано или не о чем. Правило одно на напоминание и срез (Р-50).
 */
export function waitingRecurring(data: RecurringData, day: string): Due[] {
  if (dayNumber(day) < RECURRING_FROM_DAY) return []
  return waitingIn(data, monthOf(day))
}

/** «Пора внести месяц» — текст к правилу `missingMonth`. */
export function monthNotice(entries: readonly Entry[], day: string): Notice {
  const past = missingMonth(entries, day)
  if (past === null) return null

  return {
    title: 'Пора внести месяц',
    body: `За ${formatMonth(past)} не внесено ни одной записи. Загрузите выписку — и станет видно, сколько вы отложили.`,
  }
}

/**
 * «Регулярные ждут». Считает только то, чего ещё нет: внесённое молчит.
 */
export function recurringNotice(data: RecurringData, day: string): Notice {
  const left = waitingRecurring(data, day)
  if (left.length === 0) return null
  const month = monthOf(day)

  const names = left.map((each) => each.recurring.name).join(', ')
  return {
    title: left.length === 1 ? 'Регулярная не внесена' : 'Регулярные не внесены',
    body: `За ${formatMonth(month)} ещё нет: ${names}. Внести можно одним тапом на «Операциях».`,
  }
}
