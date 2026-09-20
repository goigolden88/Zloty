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
import { dueThisMonth, type RecurringData } from './recurring.ts'

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

/** Есть ли хоть одна живая запись за этот месяц — операцией или итогом. */
export function monthHasEntries(entries: readonly Entry[], month: string): boolean {
  return entries.some((each) => {
    if (each.deleted) return false
    if (each.date?.startsWith(`${month}-`)) return true
    // Итог периода закрывает месяц, который он накрывает: вносить его
    // второй раз не нужно (Р-12, п. 6).
    return each.period !== undefined && each.period.from <= `${month}-31` && `${month}-01` <= each.period.to
  })
}

/**
 * «Пора внести месяц». Молчит, если месяц уже внесён, если сегодня слишком
 * рано или если записей нет вовсе — новому человеку напоминать не о чем,
 * ему показывают приветствие.
 */
export function monthNotice(entries: readonly Entry[], day: string): Notice {
  if (dayNumber(day) < REMIND_FROM_DAY) return null
  if (entries.every((each) => each.deleted)) return null

  const past = previousMonth(monthOf(day))
  if (monthHasEntries(entries, past)) return null

  return {
    title: 'Пора внести месяц',
    body: `За ${formatMonth(past)} не внесено ни одной записи. Загрузите выписку — и станет видно, сколько вы отложили.`,
  }
}

/**
 * «Регулярные ждут». Считает только то, чего ещё нет: внесённое молчит.
 */
export function recurringNotice(data: RecurringData, day: string): Notice {
  if (dayNumber(day) < RECURRING_FROM_DAY) return null

  const month = monthOf(day)
  const left = dueThisMonth(data, month).filter((each) => each.entries.length === 0)
  if (left.length === 0) return null

  const names = left.map((each) => each.recurring.name).join(', ')
  return {
    title: left.length === 1 ? 'Регулярная не внесена' : 'Регулярные не внесены',
    body: `За ${formatMonth(month)} ещё нет: ${names}. Внести можно одним тапом на «Операциях».`,
  }
}
