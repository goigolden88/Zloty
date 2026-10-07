/**
 * Сколько операций учёта держится за комнату (Р-57).
 *
 * Связь идёт со стороны учёта, полем `refs` (Р-31), и комната про неё
 * не знает — потому счёт лежит здесь, рядом с `shares.ts`, а не в модуле
 * долгов: только `src/summary/` смотрит на учёт и долги разом.
 *
 * Считаются связи, которые сейчас дают долю: живая операция, живая трата
 * под живым событием комнаты или живой перевод комнаты. Связь, которая уже
 * ведёт в никуда, удаление комнаты не меняет — её не в счёт.
 */

import type { Entry } from '../app/model.ts'
import type { DebtsData } from '../modules/debts/summary.ts'

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

/** Число живых операций учёта, у которых в `refs` — трата или перевод комнаты. */
export function roomLinks(roomId: string, entries: readonly Entry[], debts: DebtsData): number {
  const events = new Set(
    live(debts.roomEvents)
      .filter((each) => each.roomId === roomId)
      .map((each) => each.id),
  )
  const targets = new Set([
    ...live(debts.roomSpends)
      .filter((each) => events.has(each.eventId))
      .map((each) => each.id),
    ...live(debts.roomTransfers)
      .filter((each) => each.roomId === roomId)
      .map((each) => each.id),
  ])

  return live(entries).filter((entry) => (entry.refs ?? []).some((ref) => targets.has(ref))).length
}
