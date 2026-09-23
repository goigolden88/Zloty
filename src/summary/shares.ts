/**
 * Своя доля связанной операции (Р-31).
 *
 * Единственное место, которое смотрит на учёт и на долги разом, — потому
 * и лежит в `src/summary/`, а не в модуле: модули друг про друга не знают
 * (02-Архитектура, «Структура кода»). Связь идёт со стороны учёта, полем
 * `refs` операции; комната про операции не знает вовсе (условие 5 Р-01).
 *
 * Правило одно на расход и на доход: **есть связь — в поток входит доля,
 * а не сумма.** У траты комнаты доля — сумма долей человека с пометкой
 * `self`; у разового долга, возврата и перевода комнаты — ноль: долги
 * не расход и не доход (Р-05).
 *
 * Ничего не угадывается: операция без `refs` считается целиком, как была
 * (Р-19 — тот же принцип, что у встречных переводов).
 */

import type { Entry, Money } from '../app/model.ts'
import { shareOf } from '../modules/debts/split.ts'
import { selfOf, type DebtsData } from '../modules/debts/summary.ts'

export type Shares = {
  /** По `id` операции — сколько из неё настоящий поток. Нет записи — вся сумма. */
  amounts: Map<string, Money>
  /** Связь никуда не ведёт: запись удалили на другом устройстве. */
  broken: Entry[]
  /** Связи в разных валютах: сложить их нельзя, доля не считается. */
  mixed: Entry[]
  /** Пометки «это я» нет — чью долю брать, неизвестно. */
  noSelf: boolean
}

const EMPTY: Shares = { amounts: new Map(), broken: [], mixed: [], noSelf: false }

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

/**
 * Доли всех связанных операций разом.
 *
 * Связей у операции может быть несколько — тогда доли складываются. В разных
 * валютах они не складываются (Р-04), и такая операция не подменяется молча:
 * её называют.
 */
export function ownShares(entries: readonly Entry[], debts: DebtsData): Shares {
  const linked = live(entries).filter((entry) => entry.refs && entry.refs.length > 0)
  if (linked.length === 0) return EMPTY

  const me = selfOf(debts.people)
  if (!me) return { ...EMPTY, noSelf: true }

  const spends = new Map(live(debts.roomSpends).map((each) => [each.id, each]))
  const events = new Map(live(debts.roomEvents).map((each) => [each.id, each]))
  const rooms = new Map(live(debts.rooms).map((each) => [each.id, each]))
  const loans = new Map(live(debts.loans).map((each) => [each.id, each]))
  const repayments = new Map(live(debts.repayments).map((each) => [each.id, each]))
  const transfers = new Map(live(debts.roomTransfers).map((each) => [each.id, each]))

  const amounts = new Map<string, Money>()
  const broken: Entry[] = []
  const mixed: Entry[] = []

  for (const entry of linked) {
    const parts: Money[] = []
    let lost = false

    for (const ref of entry.refs ?? []) {
      const spend = spends.get(ref)
      if (spend) {
        const room = rooms.get(events.get(spend.eventId)?.roomId ?? '')
        if (!room) {
          lost = true
          continue
        }
        parts.push({ amount: shareOf(spend, me.id), currency: room.currency })
        continue
      }

      // Долг, возврат и перевод комнаты — не поток вовсе: доля ноль.
      const loan = loans.get(ref)
      if (loan) {
        parts.push({ amount: 0, currency: loan.money.currency })
        continue
      }
      const repayment = repayments.get(ref)
      if (repayment) {
        parts.push({ amount: 0, currency: repayment.money.currency })
        continue
      }
      const transfer = transfers.get(ref)
      if (transfer) {
        parts.push({ amount: 0, currency: rooms.get(transfer.roomId)?.currency ?? entry.money.currency })
        continue
      }

      lost = true
    }

    if (lost || parts.length === 0) {
      broken.push(entry)
      continue
    }

    const currency = parts[0]?.currency ?? entry.money.currency
    if (parts.some((part) => part.currency !== currency)) {
      mixed.push(entry)
      continue
    }

    amounts.set(entry.id, {
      amount: parts.reduce((sum, part) => sum + part.amount, 0),
      currency,
    })
  }

  return { amounts, broken, mixed, noSelf: false }
}

/** Связана ли операция хоть с чем-нибудь. */
export function isLinked(entry: Entry): boolean {
  return (entry.refs?.length ?? 0) > 0
}
