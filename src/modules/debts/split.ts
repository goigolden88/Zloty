/**
 * Доли одной траты события (Р-30, Р-33).
 *
 * Здесь вся арифметика разделённой траты, и она целая: суммы — в минимальных
 * единицах валюты комнаты (условие 6 Р-01, Р-04). Дробных долей не бывает,
 * поэтому у деления есть остаток, и у остатка обязан быть хозяин.
 *
 * **Доля задаётся двумя способами** (Р-33):
 * — `share` — **суммой**: «Боря взял на 700». Берёт ровно своё;
 * — `weight` — **весом**: «Боре две порции, Вере одна». Остаток после сумм
 *   делится пропорционально весам. Нет ни суммы, ни веса — вес один, то есть
 *   поровну: старые траты без весов считаются ровно как раньше.
 *
 * Вес — не сумма, а отношение, и дробным быть может: «полторы порции».
 * Правило Р-04 о целых суммах он не нарушает — целыми остаются доли.
 *
 * **Остаток достаётся плательщику** (Р-32). Тысяча на троих — две доли
 * по одной сумме и одна на копейку больше, и лишняя копейка идёт тому, кто
 * платил. Плательщика среди делящих нет — первому из делящих по списку.
 */

import type { RoomSpend } from '../../app/model.ts'

/** Доли трат: кому сколько своего расхода. Сумма всегда равна сумме траты. */
export type Shares = Map<string, number>

/** Сколько знаков веса учитывается: «1,5 порции» — да, «1,333…» — до сотых. */
const WEIGHT_SCALE = 100

/** Вес целым в сотых: деление идёт по целым, и двоичная дробь не теряет копейку. */
function scaled(weight: number | undefined): number {
  return Math.round((weight ?? 1) * WEIGHT_SCALE)
}

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
    if (part.share !== undefined && part.weight !== undefined) {
      return 'У одного человека и сумма, и вес — нужно что-то одно'
    }
    if (part.share !== undefined && (!Number.isInteger(part.share) || part.share < 0)) {
      return 'Доля суммой должна быть целой и не меньше нуля'
    }
    if (part.weight !== undefined && (!Number.isFinite(part.weight) || part.weight < 0)) {
      return 'Вес должен быть числом не меньше нуля'
    }
  }

  const fixed = spend.split.reduce((sum, part) => sum + (part.share ?? 0), 0)
  const sharing = spend.split.filter((part) => part.share === undefined)
  const weights = sharing.reduce((sum, part) => sum + scaled(part.weight), 0)

  if (fixed > spend.amount) return `Доли больше траты на ${fixed - spend.amount}`
  if (fixed < spend.amount && sharing.length === 0) return `Доли меньше траты на ${spend.amount - fixed}`
  if (fixed < spend.amount && weights === 0) return 'Все веса нулевые — остаток делить не на кого'

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

  const fixed = [...shares.values()].reduce((sum, each) => sum + each, 0)
  const rest = spend.amount - fixed

  // Делят остаток те, у кого нет суммы и вес больше нуля.
  const sharing = spend.split
    .filter((part) => part.share === undefined && scaled(part.weight) > 0)
    .map((part) => ({ personId: part.personId, weight: scaled(part.weight) }))
  const total = sharing.reduce((sum, part) => sum + part.weight, 0)

  if (rest > 0 && total > 0) {
    let given = 0
    for (const part of sharing) {
      const each = Math.floor((rest * part.weight) / total)
      shares.set(part.personId, each)
      given += each
    }
    give(shares, spend, sharing.map((part) => part.personId), rest - given)
  } else if (rest !== 0) {
    // Делить не на кого — хвост всё равно чей-то: либо доли не сошлись
    // с суммой, либо все веса нулевые.
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

/** Как делится трата — для подписи на экране. */
export type SplitMode = 'equal' | 'amounts' | 'weights'

/**
 * Способ деления, каким его видит человек. Суммы важнее весов: трата,
 * где кто-то «взял на 700», читается как «суммами», даже если у остальных
 * стоят веса.
 */
export function splitMode(spend: Pick<RoomSpend, 'split'>): SplitMode {
  if (spend.split.some((part) => part.share !== undefined)) return 'amounts'
  if (spend.split.some((part) => part.weight !== undefined && part.weight !== 1)) return 'weights'
  return 'equal'
}
