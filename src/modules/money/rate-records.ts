/**
 * Курс, внесённый руками (Р-04, п. 3): завести, поправить, убрать.
 *
 * Естественный ключ курса — дата и пара валют. Курс на ту же дату и пару
 * второй записью не заводится — прежняя правится: две записи одной пары на
 * один день спорили бы, какая из них «курс на дату». Курс той же пары,
 * записанный в обратную сторону, — тот же курс: его правят там, где он есть.
 */

import type { CurrencyCode, Rate } from '../../app/model.ts'
import { nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'

export type RateDraft = { date: string; from: CurrencyCode; to: CurrencyCode; rate: number }

/** Почему курс нельзя записать; `null` — можно. */
export function rateProblem(list: readonly Rate[], draft: RateDraft, selfId?: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return 'у курса нет даты'
  if (!draft.from || !draft.to) return 'нужны обе валюты'
  if (draft.from === draft.to) return 'курс валюты к самой себе — всегда единица, вносить его не нужно'
  if (!Number.isFinite(draft.rate) || draft.rate <= 0) return 'курс — число больше нуля'
  const inverse = list.find(
    (each) => !each.deleted && each.id !== selfId && each.date === draft.date && each.from === draft.to && each.to === draft.from,
  )
  if (inverse) return `на эту дату уже есть курс ${inverse.from}→${inverse.to} — поправьте его, а не заводите обратный`
  return null
}

/** Записать курс руками: такая пара на эту дату уже есть — правится она. */
export function rateWrite(list: readonly Rate[], draft: RateDraft): Rate {
  const same = list.find((each) => !each.deleted && each.date === draft.date && each.from === draft.from && each.to === draft.to)
  const base = same ?? { id: ulid() }
  return { ...base, updatedAt: nowIso(), date: draft.date, from: draft.from, to: draft.to, rate: draft.rate, source: 'manual' }
}

/** Живые курсы на дату, по паре — чтобы список на экране не прыгал. */
export function ratesOn(list: readonly Rate[], date: string): Rate[] {
  return list
    .filter((each) => !each.deleted && each.date === date)
    .sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))
}
