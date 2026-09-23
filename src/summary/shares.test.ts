import { describe, expect, it } from 'vitest'
import type { Currency, Entry, Loan, Person, Room, RoomEvent, RoomSpend, RoomTransfer } from '../app/model.ts'
import type { DebtsData } from '../modules/debts/summary.ts'
import { monthReport, type MonthData } from '../modules/ledger/month.ts'
import { ownShares } from './shares.ts'
import { debtsForReport } from './debts-report.ts'

/** Люди, комнаты и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'
const RUB: Currency = { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }
const USD: Currency = { id: 'c2', updatedAt: AT, code: 'USD', name: 'Доллар', decimals: 2, order: 1 }

const ANYA = 'person-anya'
const BORYA = 'person-borya'
const VERA = 'person-vera'

const people: Person[] = [
  { id: ANYA, updatedAt: AT, name: 'Аня', self: true },
  { id: BORYA, updatedAt: AT, name: 'Боря' },
  { id: VERA, updatedAt: AT, name: 'Вера' },
]

const room: Room = { id: 'room-1', updatedAt: AT, name: 'Лето', currency: 'RUB', personIds: [ANYA, BORYA, VERA] }
const event: RoomEvent = {
  id: 'event-1',
  updatedAt: AT,
  roomId: 'room-1',
  name: 'Корт',
  date: '2026-09-12',
  personIds: [ANYA, BORYA, VERA],
}

/** Ужин на троих за 3 000: заплатила Аня, своя доля — 1 000. */
const spend: RoomSpend = {
  id: 'spend-1',
  updatedAt: AT,
  eventId: 'event-1',
  date: '2026-09-12',
  title: 'Ужин',
  payerId: ANYA,
  amount: 300000,
  split: [{ personId: ANYA }, { personId: BORYA }, { personId: VERA }],
}

const loan: Loan = {
  id: 'loan-1',
  updatedAt: AT,
  personId: BORYA,
  direction: 'lent',
  money: { amount: 500000, currency: 'RUB' },
  date: '2026-09-03',
}

function debts(over: Partial<DebtsData> = {}): DebtsData {
  return {
    people,
    rooms: [room],
    roomEvents: [event],
    roomSpends: [spend],
    roomTransfers: [],
    loans: [],
    repayments: [],
    ...over,
  }
}

let seq = 0
function entry(fields: Partial<Entry> & { kind: Entry['kind']; amount: number }): Entry {
  const { amount, ...rest } = fields
  return {
    id: `e-${++seq}`,
    updatedAt: AT,
    accountId: 'acc',
    money: { amount, currency: 'RUB' },
    ...rest,
  } as Entry
}

describe('доля связанной операции (Р-31)', () => {
  it('операция без связи не трогается вовсе', () => {
    const plain = entry({ kind: 'expense', amount: 300000, date: '2026-09-12' })
    expect(ownShares([plain], debts()).amounts.size).toBe(0)
  })

  it('связана с тратой комнаты — в поток идёт своя доля, а не сумма банка', () => {
    const paid = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-1'] })
    expect(ownShares([paid], debts()).amounts.get(paid.id)).toEqual({ amount: 100000, currency: 'RUB' })
  })

  it('платил не я — моей доли нет, и в поток не идёт ничего', () => {
    const his: RoomSpend = { ...spend, payerId: BORYA, split: [{ personId: BORYA }, { personId: VERA }] }
    const paid = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-1'] })
    expect(ownShares([paid], debts({ roomSpends: [his] })).amounts.get(paid.id)).toEqual({
      amount: 0,
      currency: 'RUB',
    })
  })

  it('связей несколько — доли складываются', () => {
    const second: RoomSpend = { ...spend, id: 'spend-2', amount: 60000 }
    const paid = entry({ kind: 'expense', amount: 360000, date: '2026-09-12', refs: ['spend-1', 'spend-2'] })
    expect(ownShares([paid], debts({ roomSpends: [spend, second] })).amounts.get(paid.id)).toEqual({
      amount: 120000,
      currency: 'RUB',
    })
  })

  it('разовый долг, возврат и перевод комнаты — доля ноль: долги не поток (Р-05)', () => {
    const repayment = { id: 'rep-1', updatedAt: AT, loanId: 'loan-1', money: { amount: 200000, currency: 'RUB' }, date: '2026-09-20' }
    const transfer: RoomTransfer = {
      id: 'tr-1',
      updatedAt: AT,
      roomId: 'room-1',
      date: '2026-09-20',
      fromId: BORYA,
      toId: ANYA,
      amount: 100000,
    }
    const gave = entry({ kind: 'expense', amount: 500000, date: '2026-09-03', refs: ['loan-1'] })
    const back = entry({ kind: 'income', amount: 200000, date: '2026-09-20', refs: ['rep-1'] })
    const moved = entry({ kind: 'income', amount: 100000, date: '2026-09-20', refs: ['tr-1'] })

    const shares = ownShares([gave, back, moved], debts({ loans: [loan], repayments: [repayment], roomTransfers: [transfer] }))
    expect(shares.amounts.get(gave.id)?.amount).toBe(0)
    expect(shares.amounts.get(back.id)?.amount).toBe(0)
    expect(shares.amounts.get(moved.id)?.amount).toBe(0)
  })

  it('связь ведёт в никуда — операция считается целиком и называется', () => {
    const paid = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-нет'] })
    const shares = ownShares([paid], debts())
    expect(shares.amounts.size).toBe(0)
    expect(shares.broken.map((each) => each.id)).toEqual([paid.id])
  })

  it('связи в разных валютах не складываются — операция считается целиком и называется', () => {
    const other: Room = { ...room, id: 'room-2', currency: 'USD' }
    const otherEvent: RoomEvent = { ...event, id: 'event-2', roomId: 'room-2' }
    const otherSpend: RoomSpend = { ...spend, id: 'spend-2', eventId: 'event-2' }
    const paid = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-1', 'spend-2'] })

    const shares = ownShares(
      [paid],
      debts({ rooms: [room, other], roomEvents: [event, otherEvent], roomSpends: [spend, otherSpend] }),
    )
    expect(shares.amounts.size).toBe(0)
    expect(shares.mixed.map((each) => each.id)).toEqual([paid.id])
  })

  it('пометки «это я» нет — доли не считаются, и об этом сказано', () => {
    const paid = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-1'] })
    const shares = ownShares([paid], debts({ people: people.map(({ self: _self, ...rest }) => rest) }))
    expect(shares.noSelf).toBe(true)
    expect(shares.amounts.size).toBe(0)
  })

  it('удалённая операция долей не получает', () => {
    const gone = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-1'], deleted: true })
    expect(ownShares([gone], debts()).amounts.size).toBe(0)
  })
})

describe('расход месяца берёт долю, а не сумму', () => {
  const paid = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-1'], categoryId: 'food' })

  it('без долей расход равен сумме банка', () => {
    const data: MonthData = { entries: [paid], currencies: [RUB], rates: [], base: 'RUB' }
    expect(monthReport(data, '2026-09').expense.amount).toBe(300000)
  })

  it('с долями — только своя тысяча', () => {
    const data: MonthData = {
      entries: [paid],
      currencies: [RUB],
      rates: [],
      base: 'RUB',
      shares: ownShares([paid], debts()).amounts,
    }
    expect(monthReport(data, '2026-09').expense.amount).toBe(100000)
    // Операция из счёта не пропала: она посчитана, просто своей долей.
    expect(monthReport(data, '2026-09').expense.entries).toBe(1)
  })
})

describe('числа долгов для отчёта месяца (Р-31)', () => {
  const paid = entry({ kind: 'expense', amount: 300000, date: '2026-09-12', refs: ['spend-1'], categoryId: 'food' })
  const data: MonthData = {
    entries: [paid],
    currencies: [RUB, USD],
    rates: [],
    base: 'RUB',
    shares: ownShares([paid], debts()).amounts,
  }

  it('называет, сколько не вошло в расход и по скольким операциям', () => {
    const out = debtsForReport({ month: '2026-09', entries: [paid], debts: debts(), data })
    expect(out.cut).toEqual({ amount: 200000, entries: 1 })
  })

  it('долг на конец месяца считает то, что уже случилось', () => {
    const out = debtsForReport({ month: '2026-09', entries: [paid], debts: debts({ loans: [loan] }), data })
    // 2 000 по комнате (Боря и Вера по 1 000) и 5 000 разовым долгом.
    expect(out.owedToMe).toBe(700000)
    expect(out.owedByMe).toBe(0)
  })

  it('и не считает того, что случится позже', () => {
    const later: Loan = { ...loan, id: 'loan-2', date: '2026-10-05' }
    const out = debtsForReport({ month: '2026-09', entries: [paid], debts: debts({ loans: [later] }), data })
    expect(out.owedToMe).toBe(200000)
  })

  it('перевод внутри месяца долг закрывает', () => {
    const back: RoomTransfer = {
      id: 'tr-1',
      updatedAt: AT,
      roomId: 'room-1',
      date: '2026-09-20',
      fromId: BORYA,
      toId: ANYA,
      amount: 100000,
    }
    const out = debtsForReport({ month: '2026-09', entries: [paid], debts: debts({ roomTransfers: [back] }), data })
    expect(out.owedToMe).toBe(100000)
  })

  it('долгов нет — всё по нулям, и отчёт о них промолчит', () => {
    const plain = entry({ kind: 'expense', amount: 300000, date: '2026-09-12' })
    const clean: MonthData = { entries: [plain], currencies: [RUB], rates: [], base: 'RUB' }
    const out = debtsForReport({
      month: '2026-09',
      entries: [plain],
      debts: debts({ rooms: [], roomEvents: [], roomSpends: [] }),
      data: clean,
    })
    expect(out).toMatchObject({ cut: { amount: 0, entries: 0 }, owedToMe: 0, owedByMe: 0, broken: 0, mixed: 0 })
  })
})
