/**
 * «Сколько мне должен Боря» — по всем комнатам и разовым долгам сразу (Р-01).
 *
 * Главное для учёта — его долги и долги ему; остальное в комнате — сведения
 * для друзей. Этот файл и есть то самое «сразу»: он единственный, кто смотрит
 * на комнаты и разовые долги вместе.
 *
 * **В комнате долг не парный.** Человек должен не мне, а общему котлу: баланс
 * комнаты говорит только «Боря в минусе на 15 448». Кому именно он переводит,
 * решает минимизация (`settle`), и парный долг берётся оттуда — как во вкладке
 * «кто кому должен» образца.
 *
 * **Валюты не складываются** (Р-04): у каждой комнаты своя, у разового долга
 * своя. Итог человеку — список сумм по валютам, а не одно число. Обычно она
 * одна, и список из одной строки.
 */

import type { Loan, Money, Person, Repayment, Room, RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import { eventsOf, roomBalances, settle, spendsOf, transfersOf } from './balance.ts'
import { signedLeft } from './loans.ts'

/** Всё, что модулю долгов нужно из базы. Записей учёта здесь нет (условие 5 Р-01). */
export type DebtsData = {
  people: readonly Person[]
  rooms: readonly Room[]
  roomEvents: readonly RoomEvent[]
  roomSpends: readonly RoomSpend[]
  roomTransfers: readonly RoomTransfer[]
  loans: readonly Loan[]
  repayments: readonly Repayment[]
}

/** Откуда взялся долг — чтобы на экране было видно основание, а не одно число. */
export type DebtSource =
  | { kind: 'room'; roomId: string; money: Money }
  | { kind: 'loan'; loanId: string; money: Money }

/** Итог по человеку: плюс — он должен мне, минус — я должен ему. */
export type PersonDebt = {
  personId: string
  /** По валютам, в порядке первого появления. */
  amounts: Money[]
  sources: DebtSource[]
}

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

/**
 * «Я» — человек с пометкой `self` (условие 2 Р-01).
 *
 * Пометки нет — ответа нет: владельцем первого попавшегося человека
 * приложение не назначает. Записей с пометкой несколько — берётся правленная
 * позже, тем же правилом, что у настроек учёта.
 */
export function selfOf(people: readonly Person[]): Person | null {
  const marked = live(people).filter((person) => person.self)
  if (marked.length === 0) return null
  return marked.reduce((best, each) => (each.updatedAt > best.updatedAt ? each : best))
}

/** Долги всех людей передо мной и мои перед ними. Пометки «я» нет — список пуст. */
export function debtsByPerson(data: DebtsData): PersonDebt[] {
  const me = selfOf(data.people)
  if (!me) return []

  const found = new Map<string, PersonDebt>()
  const add = (personId: string, money: Money, source: DebtSource) => {
    if (money.amount === 0) return
    const debt = found.get(personId) ?? { personId, amounts: [], sources: [] }
    const same = debt.amounts.find((each) => each.currency === money.currency)
    if (same) same.amount += money.amount
    else debt.amounts.push({ ...money })
    debt.sources.push(source)
    found.set(personId, debt)
  }

  for (const room of live(data.rooms)) {
    const events = eventsOf(data.roomEvents, room.id)
    const spends = events.flatMap((event) => spendsOf(data.roomSpends, event.id))
    const balances = roomBalances(room.personIds, spends, transfersOf(data.roomTransfers, room.id))

    for (const line of settle(balances)) {
      // Мне переводят — человек должен мне; перевожу я — должен я.
      if (line.toId === me.id) {
        add(line.fromId, { amount: line.amount, currency: room.currency }, {
          kind: 'room',
          roomId: room.id,
          money: { amount: line.amount, currency: room.currency },
        })
      } else if (line.fromId === me.id) {
        add(line.toId, { amount: -line.amount, currency: room.currency }, {
          kind: 'room',
          roomId: room.id,
          money: { amount: -line.amount, currency: room.currency },
        })
      }
    }
  }

  for (const loan of live(data.loans)) {
    const money = signedLeft(loan, data.repayments)
    add(loan.personId, money, { kind: 'loan', loanId: loan.id, money })
  }

  // Нулевые убираются: «Вера 0,00» уместна внутри комнаты, где человек
  // участвует, а в списке «кто мне должен» это шум.
  return [...found.values()]
    .map((debt) => ({ ...debt, amounts: debt.amounts.filter((money) => money.amount !== 0) }))
    .filter((debt) => debt.amounts.length > 0)
}

/** Сколько должен один человек. Нет долга — пустой список сумм. */
export function debtOf(data: DebtsData, personId: string): PersonDebt {
  return (
    debtsByPerson(data).find((debt) => debt.personId === personId) ?? {
      personId,
      amounts: [],
      sources: [],
    }
  )
}

/**
 * Итог по всем людям разом: сколько мне должны и сколько должен я, по валютам.
 * Встречные не схлопываются: «мне должны 5 000, я должен 2 000» — два числа,
 * а не одно, потому что это разные люди и разные сроки.
 */
export function debtTotals(data: DebtsData): { owedToMe: Money[]; owedByMe: Money[] } {
  const owedToMe: Money[] = []
  const owedByMe: Money[] = []

  const put = (into: Money[], money: Money) => {
    const same = into.find((each) => each.currency === money.currency)
    if (same) same.amount += money.amount
    else into.push({ ...money })
  }

  for (const debt of debtsByPerson(data)) {
    for (const money of debt.amounts) {
      if (money.amount > 0) put(owedToMe, money)
      else put(owedByMe, { amount: -money.amount, currency: money.currency })
    }
  }

  return { owedToMe, owedByMe }
}
