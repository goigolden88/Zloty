/**
 * С чем можно связать операцию и что эта связь значит (Р-31).
 *
 * Вторая половина сводки: `shares.ts` считает долю, а здесь она называется
 * словами — для списка выбора и для строки в ленте. Обе стороны смотрят
 * на учёт и на долги сразу, потому и лежат в `src/summary/`.
 *
 * Приложение не угадывает, какую трату имел в виду человек: список
 * сортируется по близости даты, но выбирает он сам (Р-19).
 */

import type { Currency, Entry, Money } from '../app/model.ts'
import { nameOf } from '../modules/debts/records.ts'
import { shareOf } from '../modules/debts/split.ts'
import { selfOf, type DebtsData } from '../modules/debts/summary.ts'
import { findCurrency, formatMoney } from '../modules/money/money.ts'
import { formatDateLoose } from '../shared/core/dates.ts'

export type LinkGroup = 'Траты комнат' | 'Долги и возвраты'

export type LinkChoice = {
  id: string
  group: LinkGroup
  label: string
  /** Для сортировки по близости к дате операции. */
  date: string
}

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

const daysApart = (a: string, b: string): number => {
  const one = Date.parse(`${a}T00:00:00Z`)
  const two = Date.parse(`${b}T00:00:00Z`)
  return Number.isNaN(one) || Number.isNaN(two) ? Number.MAX_SAFE_INTEGER : Math.abs(one - two)
}

/**
 * Всё, с чем можно связать операцию, ближайшее по дате — первым.
 *
 * `near` — дата операции: чаще всего нужная трата случилась в тот же день,
 * и листать за ней весь год незачем.
 */
export function linkChoices(
  debts: DebtsData,
  currencies: readonly Currency[],
  near?: string,
): LinkChoice[] {
  const show = (money: Money) => formatMoney(money, findCurrency(currencies, money.currency))
  const rooms = new Map(live(debts.rooms).map((each) => [each.id, each]))
  const events = new Map(live(debts.roomEvents).map((each) => [each.id, each]))
  const out: LinkChoice[] = []

  for (const spend of live(debts.roomSpends)) {
    const room = rooms.get(events.get(spend.eventId)?.roomId ?? '')
    if (!room) continue
    out.push({
      id: spend.id,
      group: 'Траты комнат',
      date: spend.date,
      label:
        `${formatDateLoose(spend.date)} · ${spend.title} · ${room.name} · ` +
        show({ amount: spend.amount, currency: room.currency }),
    })
  }

  for (const loan of live(debts.loans)) {
    const who = nameOf(debts.people, loan.personId)
    out.push({
      id: loan.id,
      group: 'Долги и возвраты',
      date: loan.date,
      // Двоеточием, а не «дал Боре»: имя склонять нечем, и «дал Боря»
      // читается как ошибка.
      label:
        `${formatDateLoose(loan.date)} · ${loan.direction === 'lent' ? 'дал в долг' : 'взял в долг'}: ${who} · ` +
        show(loan.money),
    })
  }

  const loans = new Map(live(debts.loans).map((each) => [each.id, each]))
  for (const repayment of live(debts.repayments)) {
    const loan = loans.get(repayment.loanId)
    if (!loan) continue
    const who = nameOf(debts.people, loan.personId)
    out.push({
      id: repayment.id,
      group: 'Долги и возвраты',
      date: repayment.date,
      label:
        `${formatDateLoose(repayment.date)} · ` +
        `${loan.direction === 'lent' ? 'вернули мне' : 'вернул я'}: ${who} · ${show(repayment.money)}`,
    })
  }

  for (const transfer of live(debts.roomTransfers)) {
    const room = rooms.get(transfer.roomId)
    if (!room) continue
    out.push({
      id: transfer.id,
      group: 'Долги и возвраты',
      date: transfer.date,
      label:
        `${formatDateLoose(transfer.date)} · ${nameOf(debts.people, transfer.fromId)} → ` +
        `${nameOf(debts.people, transfer.toId)} · ${room.name} · ` +
        show({ amount: transfer.amount, currency: room.currency }),
    })
  }

  if (!near) return out.sort((a, b) => b.date.localeCompare(a.date))
  return out.sort((a, b) => daysApart(a.date, near) - daysApart(b.date, near) || b.date.localeCompare(a.date))
}

/**
 * Что показать под связанной операцией: доля вместе с основанием.
 *
 * `null` — операция ни с чем не связана. Связь, ведущая в никуда, тоже
 * называется: она означает, что в расход операция вошла целиком.
 */
export function linkNote(
  entry: Entry,
  debts: DebtsData,
  currencies: readonly Currency[],
): string | null {
  const refs = entry.refs ?? []
  if (refs.length === 0) return null

  const me = selfOf(debts.people)
  const show = (money: Money) => formatMoney(money, findCurrency(currencies, money.currency))
  const rooms = new Map(live(debts.rooms).map((each) => [each.id, each]))
  const events = new Map(live(debts.roomEvents).map((each) => [each.id, each]))
  const spends = new Map(live(debts.roomSpends).map((each) => [each.id, each]))
  const loans = new Map(live(debts.loans).map((each) => [each.id, each]))
  const repayments = new Map(live(debts.repayments).map((each) => [each.id, each]))
  const transfers = new Map(live(debts.roomTransfers).map((each) => [each.id, each]))

  const parts: string[] = []
  let share = 0
  let currency = ''
  let known = true

  for (const ref of refs) {
    const spend = spends.get(ref)
    if (spend) {
      const room = rooms.get(events.get(spend.eventId)?.roomId ?? '')
      if (!room) {
        known = false
        continue
      }
      parts.push(`${spend.title}, комната «${room.name}»`)
      share += me ? shareOf(spend, me.id) : 0
      currency = room.currency
      continue
    }

    const loan = loans.get(ref)
    if (loan) {
      parts.push(
        `${loan.direction === 'lent' ? 'дал в долг' : 'взял в долг'}: ${nameOf(debts.people, loan.personId)}`,
      )
      continue
    }
    const repayment = repayments.get(ref)
    if (repayment) {
      parts.push('возврат долга')
      continue
    }
    const transfer = transfers.get(ref)
    if (transfer) {
      parts.push(`перевод в комнате «${rooms.get(transfer.roomId)?.name ?? '—'}»`)
      continue
    }

    known = false
  }

  if (!known) return 'связь ведёт в никуда: записи больше нет, и в расход операция вошла целиком'
  if (!me) return `${parts.join(', ')} · доля не посчитана: нет пометки «это я»`
  if (currency === '') return `${parts.join(', ')} · в расход и доход не входит`
  return `своя доля ${show({ amount: share, currency })} · ${parts.join(', ')}`
}
