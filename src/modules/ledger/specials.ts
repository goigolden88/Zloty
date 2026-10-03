/**
 * Особые периоды трат: поездка, отдых — дни, когда расход выше обычного (Р-55).
 *
 * Особая трата — та, у которой стоит флаг `special` (Р-05), или расход
 * с датой внутри особого периода. Второе считается при чтении: флаг в запись
 * не пишется, и удалённый или подвинутый период возвращает траты в обычные
 * без переписывания записей. Выписка, загруженная после поездки, попадает
 * в период сама.
 *
 * Особым по периоду не становится:
 *
 * — расход, связанный с регулярной: аренда в месяц поездки — обычная;
 * — итог периода (`period` вместо `date`): он и так не дробится по дням;
 * — доход и перевод: для доходов пока ничего не делается.
 */

import type { Entry, SpecialPeriod } from '../../app/model.ts'
import { formatDate, isDateStr, nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'

/** Подпись периода без названия. */
export const SPECIAL_UNTITLED = 'Особый период'

/** Чем называть период человеку. */
export function specialTitle(period: SpecialPeriod): string {
  return period.title?.trim() || SPECIAL_UNTITLED
}

/** Живые периоды — без надгробий, от ранних к поздним. */
export function liveSpecials(specials: readonly SpecialPeriod[]): SpecialPeriod[] {
  return specials.filter((each) => !each.deleted).sort((a, b) => a.from.localeCompare(b.from))
}

/**
 * Особый период, в который трата попадает датой. Null — не попадает
 * или по периоду особой не становится: не расход, итог периода, регулярная.
 */
export function specialPeriodOf(entry: Entry, specials: readonly SpecialPeriod[] = []): SpecialPeriod | null {
  if (entry.kind !== 'expense' || entry.recurringId !== undefined || entry.period !== undefined) return null
  const day = entry.date
  if (day === undefined) return null
  return specials.find((each) => !each.deleted && each.from <= day && day <= each.to) ?? null
}

/**
 * Особая ли трата: флаг или особый период (Р-05, Р-55).
 *
 * Одна на все места, где расход делится на обычный и особый: расход
 * месяца, обычный месяц, «вышло за обычное», отчёт. Флаг работает
 * как прежде — и у итога периода тоже.
 */
export function isSpecial(entry: Entry, specials: readonly SpecialPeriod[] = []): boolean {
  return entry.special === true || specialPeriodOf(entry, specials) !== null
}

/** То, что вводится в форме периода. */
export type SpecialDraft = { from: string; to: string; title?: string }

/**
 * Почему период нельзя записать; `null` — можно.
 *
 * Периоды не пересекаются: иначе трата попала бы в два сразу, и сумма
 * поездки посчиталась бы дважды. Задетый период называется — названием
 * и датами, чтобы было видно, какой двигать.
 *
 * `selfId` — период, который правится: с самим собой он не сравнивается.
 */
export function specialProblem(
  draft: SpecialDraft,
  specials: readonly SpecialPeriod[],
  selfId?: string,
): string | null {
  if (!isDateStr(draft.from)) return 'у периода нет первого дня'
  if (!isDateStr(draft.to)) return 'у периода нет последнего дня'
  if (draft.to < draft.from) return 'последний день раньше первого'

  const touched = liveSpecials(specials).find(
    (each) => each.id !== selfId && each.from <= draft.to && draft.from <= each.to,
  )
  if (touched) {
    return (
      `задевает «${specialTitle(touched)}» ${formatDate(touched.from)} — ${formatDate(touched.to)}: ` +
      'особые периоды не пересекаются'
    )
  }
  return null
}

export function createSpecial(draft: SpecialDraft): SpecialPeriod {
  const period: SpecialPeriod = { id: ulid(), updatedAt: nowIso(), from: draft.from, to: draft.to }
  const title = draft.title?.trim()
  if (title) period.title = title
  return period
}

export function updateSpecial(period: SpecialPeriod, draft: SpecialDraft): SpecialPeriod {
  const next: SpecialPeriod = { id: period.id, updatedAt: nowIso(), from: draft.from, to: draft.to }
  const title = draft.title?.trim()
  if (title) next.title = title
  return next
}
