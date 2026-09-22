/**
 * Доли одной траты события (Р-30).
 *
 * Здесь вся арифметика разделённой траты, и она целая: суммы — в минимальных
 * единицах валюты комнаты (условие 6 Р-01, Р-04). Дробных долей не бывает,
 * поэтому у деления есть остаток, и у остатка обязан быть хозяин.
 *
 * **Остаток достаётся плательщику.** 1 000 ₽ на троих — это 333,33 + 333,33
 * + 333,34, и лишняя копейка идёт тому, кто платил: он и так платил, а «кто
 * кому должен» остаётся круглым. Плательщика среди делящих нет — остаток идёт
 * первому в списке долей: произвол, но одинаковый на всех устройствах
 * и видимый на экране.
 *
 * `share` — **сумма, а не вес**: «Боря взял на 700». У кого задан — берёт
 * ровно своё, остальное делится поровну между теми, у кого не задан.
 */

import type { RoomSpend } from '../../app/model.ts'

/** Доли трат: кому сколько своего расхода. Сумма всегда равна сумме траты. */
export type Shares = Map<string, number>

/**
 * Что не так с тратой. `null` — всё сходится.
 *
 * Экран не даёт сохранить трату с проблемой, но `sharesOf` всё равно
 * не разваливается на кривой: она обязана сойтись с суммой траты всегда.
 */
export function spendProblem(spend: RoomSpend): string | null {
  if (!Number.isInteger(spend.amount) || spend.amount <= 0) {
    return 'Сумма траты должна быть целой и больше нуля'
  }
  if (spend.split.length === 0) return 'Не сказано, на кого делится трата'

  const seen = new Set<string>()
  for (const part of spend.split) {
    if (seen.has(part.personId)) return 'Один человек в долях дважды'
    seen.add(part.personId)
    if (part.share === undefined) continue
    if (!Number.isInteger(part.share) || part.share < 0) return 'Доля должна быть целой и не меньше нуля'
  }

  const fixed = spend.split.reduce((sum, part) => sum + (part.share ?? 0), 0)
  const sharing = spend.split.filter((part) => part.share === undefined).length
  if (fixed > spend.amount) return `Доли больше траты на ${fixed - spend.amount}`
  if (sharing === 0 && fixed < spend.amount) return `Доли меньше траты на ${spend.amount - fixed}`

  return null
}

/**
 * Доли траты поимённо. Сумма долей равна `amount` всегда — и на кривой трате
 * тоже: иначе расход тихо потерялся бы между участниками.
 */
export function sharesOf(spend: RoomSpend): Shares {
  const shares: Shares = new Map()
  for (const part of spend.split) {
    shares.set(part.personId, Math.max(0, Math.trunc(part.share ?? 0)))
  }

  const sharing = spend.split.filter((part) => part.share === undefined).map((part) => part.personId)
  const fixed = spend.split.reduce((sum, part) => sum + Math.max(0, Math.trunc(part.share ?? 0)), 0)
  const rest = spend.amount - fixed

  if (sharing.length > 0 && rest > 0) {
    const each = Math.floor(rest / sharing.length)
    for (const personId of sharing) shares.set(personId, each)
    give(shares, spend, sharing, rest - each * sharing.length)
  } else if (rest !== 0) {
    // Делить не на кого — хвост всё равно чей-то: либо доли не сошлись
    // с суммой, либо всё задано поимённо и осталась копейка.
    give(shares, spend, [...shares.keys()], rest)
  }

  return shares
}

/** Остаток — плательщику; его среди делящих нет — первому по порядку. */
function give(shares: Shares, spend: RoomSpend, sharing: readonly string[], left: number): void {
  if (left === 0 || sharing.length === 0) return
  const owner = sharing.includes(spend.payerId) ? spend.payerId : sharing[0]
  if (owner === undefined) return
  shares.set(owner, (shares.get(owner) ?? 0) + left)
}

/** Своя доля в трате: сколько из неё — настоящий расход человека `personId`. */
export function shareOf(spend: RoomSpend, personId: string): number {
  return sharesOf(spend).get(personId) ?? 0
}
