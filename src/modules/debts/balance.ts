/**
 * Итог события и баланс комнаты (Р-01, Р-30).
 *
 * Ничего из этого не хранится — считается каждый раз заново (условие 4 Р-01).
 * Хранятся только факты: кто сколько заплатил, на кого делится, кто кому
 * перевёл. Сложи их по-другому — и получишь другой взгляд, не переписывая
 * ни одной записи.
 *
 * Комната здесь самостоятельна (условие 1 Р-01): ни одна функция файла
 * не знает про операции, счета и категории учёта. Связь идёт со стороны
 * учёта, полем `refs` операции (Р-31), а не отсюда.
 */

import type { RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import { sharesOf } from './split.ts'

/** Что человек внёс и что потратил на себя. Всё — в валюте комнаты, целым. */
export type PersonTotal = {
  personId: string
  /** Сколько он заплатил за всех. */
  paid: number
  /** Его собственный расход — сумма его долей. */
  personal: number
  /** `paid − personal`: плюс — ему должны, минус — должен он. */
  net: number
}

/** Кому сколько перевести, чтобы все рассчитались. */
export type Settlement = {
  fromId: string
  toId: string
  amount: number
}

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

/** Траты события, по порядку хранения; удалённые не в счёт. */
export function spendsOf(spends: readonly RoomSpend[], eventId: string): RoomSpend[] {
  return live(spends).filter((spend) => spend.eventId === eventId)
}

/** События комнаты; удалённые не в счёт. */
export function eventsOf(events: readonly RoomEvent[], roomId: string): RoomEvent[] {
  return live(events).filter((event) => event.roomId === roomId)
}

/**
 * Итог по участникам: «потрачено всего» и кто получит, а кто доплатит.
 *
 * Годится и событию, и комнате — разница только в том, какие траты подали.
 * Люди берутся из самих трат: в итоге называется тот, кто платил или на кого
 * делили, а не весь состав комнаты.
 */
export function totalsOf(spends: readonly RoomSpend[]): PersonTotal[] {
  const paid = new Map<string, number>()
  const personal = new Map<string, number>()

  for (const spend of spends) {
    paid.set(spend.payerId, (paid.get(spend.payerId) ?? 0) + spend.amount)
    for (const [personId, share] of sharesOf(spend)) {
      personal.set(personId, (personal.get(personId) ?? 0) + share)
    }
  }

  const people = [...new Set([...paid.keys(), ...personal.keys()])]
  return people.map((personId) => {
    const own = personal.get(personId) ?? 0
    const gave = paid.get(personId) ?? 0
    return { personId, paid: gave, personal: own, net: gave - own }
  })
}

/** Сколько всего потрачено в событии или комнате. */
export function spentTotal(spends: readonly RoomSpend[]): number {
  return spends.reduce((sum, spend) => sum + spend.amount, 0)
}

/**
 * Баланс комнаты: плюс — человеку должны, минус — должен он.
 *
 * Считается по всем событиям комнаты и уменьшается уже сделанными переводами:
 * перевёл — долг закрыт, и баланс переводившего растёт.
 *
 * Состав комнаты подаётся отдельно, чтобы в итоге назывались и те, у кого
 * ноль: человек в комнате есть, и молчать о нём нельзя — так же, как «кто
 * кому должен» показывает нулевых.
 */
export function roomBalances(
  personIds: readonly string[],
  spends: readonly RoomSpend[],
  transfers: readonly RoomTransfer[],
): Map<string, number> {
  const balances = new Map<string, number>(personIds.map((personId) => [personId, 0]))
  const add = (personId: string, amount: number) =>
    balances.set(personId, (balances.get(personId) ?? 0) + amount)

  for (const total of totalsOf(spends)) add(total.personId, total.net)
  for (const transfer of live(transfers)) {
    add(transfer.fromId, transfer.amount)
    add(transfer.toId, -transfer.amount)
  }

  return balances
}

/** Переводы комнаты; удалённые не в счёт. */
export function transfersOf(transfers: readonly RoomTransfer[], roomId: string): RoomTransfer[] {
  return live(transfers).filter((transfer) => transfer.roomId === roomId)
}

/**
 * Кто кому переводит, чтобы все вышли в ноль — минимальным числом переводов.
 *
 * Жадно: самый крупный должник отдаёт самому крупному получателю столько,
 * сколько закрывает меньшего из двух. Это не всегда теоретический минимум
 * (задача NP-полная), но на компании в десяток человек даёт тот же ответ,
 * а считается мгновенно и одинаково на всех устройствах: порядок задают
 * сумма и `id`, а не порядок записей.
 *
 * Сами переводы не пишутся — это подсказка. Записью становится только тот,
 * который человек отметил сделанным (Р-30).
 */
export function settle(balances: Map<string, number>): Settlement[] {
  const rank = (a: [string, number], b: [string, number]) =>
    Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1)

  const debtors = [...balances].filter(([, amount]) => amount < 0).sort(rank)
  const creditors = [...balances].filter(([, amount]) => amount > 0).sort(rank)

  const result: Settlement[] = []
  let debt = 0
  let credit = 0
  let owes = debtors[0] ? -debtors[0][1] : 0
  let gets = creditors[0] ? creditors[0][1] : 0

  while (debt < debtors.length && credit < creditors.length) {
    const from = debtors[debt]
    const to = creditors[credit]
    if (!from || !to) break

    const amount = Math.min(owes, gets)
    if (amount > 0) result.push({ fromId: from[0], toId: to[0], amount })

    owes -= amount
    gets -= amount
    if (owes === 0) {
      debt += 1
      const next = debtors[debt]
      owes = next ? -next[1] : 0
    }
    if (gets === 0) {
      credit += 1
      const next = creditors[credit]
      gets = next ? next[1] : 0
    }
  }

  return result
}
