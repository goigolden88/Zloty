import { describe, expect, it } from 'vitest'
import type { Loan, Person, Repayment, Room, RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import { debtOf, debtTotals, debtsByPerson, selfOf, type DebtsData } from './summary.ts'

/** Люди и комнаты выдуманные: код публичный (CLAUDE.md). */
const ANYA = 'person-anya'
const BORYA = 'person-borya'
const VERA = 'person-vera'
const ROOM = 'room-leto'

const at = '2026-09-22T10:00:00.000Z'

function person(id: string, name: string, self?: true): Person {
  return { id, updatedAt: at, name, ...(self ? { self } : {}) }
}

function room(over: Partial<Room> = {}): Room {
  return {
    id: ROOM,
    updatedAt: at,
    name: 'Лето',
    currency: 'RUB',
    personIds: [ANYA, BORYA, VERA],
    ...over,
  }
}

function event(over: Partial<RoomEvent> = {}): RoomEvent {
  return {
    id: 'event-1',
    updatedAt: at,
    roomId: ROOM,
    name: 'Корт',
    date: '2026-08-21',
    personIds: [ANYA, BORYA, VERA],
    ...over,
  }
}

function spend(over: Partial<RoomSpend> = {}): RoomSpend {
  return {
    id: 'spend-1',
    updatedAt: at,
    eventId: 'event-1',
    date: '2026-08-21',
    title: 'Корт',
    payerId: ANYA,
    amount: 300000,
    split: [{ personId: ANYA }, { personId: BORYA }, { personId: VERA }],
    ...over,
  }
}

function data(over: Partial<DebtsData> = {}): DebtsData {
  return {
    people: [person(ANYA, 'Аня', true), person(BORYA, 'Боря'), person(VERA, 'Вера')],
    rooms: [room()],
    roomEvents: [event()],
    roomSpends: [spend()],
    roomTransfers: [],
    loans: [],
    repayments: [],
    ...over,
  }
}

describe('«я» — человек с пометкой, а не подразумеваемый владелец (условие 2 Р-01)', () => {
  it('пометка есть — он и есть я', () => {
    expect(selfOf([person(ANYA, 'Аня', true), person(BORYA, 'Боря')])?.id).toBe(ANYA)
  })

  it('пометки нет — приложение не назначает владельцем первого попавшегося', () => {
    expect(selfOf([person(BORYA, 'Боря'), person(VERA, 'Вера')])).toBeNull()
    expect(debtsByPerson(data({ people: [person(BORYA, 'Боря'), person(VERA, 'Вера')] }))).toEqual([])
  })

  it('пометок несколько — побеждает правленная позже', () => {
    const early = { ...person(BORYA, 'Боря', true), updatedAt: '2026-09-01T00:00:00.000Z' }
    const late = { ...person(ANYA, 'Аня', true), updatedAt: '2026-09-20T00:00:00.000Z' }
    expect(selfOf([early, late])?.id).toBe(ANYA)
  })

  it('удалённая пометка не считается', () => {
    expect(selfOf([{ ...person(ANYA, 'Аня', true), deleted: true }])).toBeNull()
  })
})

describe('долг в комнате парным становится после минимизации', () => {
  it('заплатила я за троих — оба должны мне свою долю', () => {
    const debts = debtsByPerson(data())
    expect(debtOf(data(), BORYA).amounts).toEqual([{ amount: 100000, currency: 'RUB' }])
    expect(debtOf(data(), VERA).amounts).toEqual([{ amount: 100000, currency: 'RUB' }])
    expect(debts).toHaveLength(2)
  })

  it('платил не я — должна я, и это минус', () => {
    const mine = data({ roomSpends: [spend({ payerId: BORYA })] })
    expect(debtOf(mine, BORYA).amounts).toEqual([{ amount: -100000, currency: 'RUB' }])
  })

  it('перевели — долг исчезает из списка, а не висит нулём', () => {
    const paid: RoomTransfer = {
      id: 'transfer-1',
      updatedAt: at,
      roomId: ROOM,
      date: '2026-09-01',
      fromId: BORYA,
      toId: ANYA,
      amount: 100000,
    }
    const after = data({ roomTransfers: [paid] })
    expect(debtOf(after, BORYA).amounts).toEqual([])
    expect(debtsByPerson(after).map((each) => each.personId)).toEqual([VERA])
  })

  it('долги, в которых меня нет, в мой список не идут', () => {
    const others = data({ roomSpends: [spend({ payerId: BORYA, split: [{ personId: VERA }] })] })
    expect(debtsByPerson(others)).toEqual([])
  })

  it('удалённая комната не считается', () => {
    expect(debtsByPerson(data({ rooms: [room({ deleted: true })] }))).toEqual([])
  })
})

describe('комнаты и разовые долги складываются — но только в одной валюте (Р-04)', () => {
  const lent: Loan = {
    id: 'loan-1',
    updatedAt: at,
    personId: BORYA,
    direction: 'lent',
    money: { amount: 500000, currency: 'RUB' },
    date: '2026-08-10',
  }

  it('долг комнаты и разовый долг того же человека — одно число', () => {
    const both = data({ loans: [lent] })
    expect(debtOf(both, BORYA).amounts).toEqual([{ amount: 600000, currency: 'RUB' }])
    expect(debtOf(both, BORYA).sources).toHaveLength(2)
  })

  it('возврат уменьшает разовый долг', () => {
    const back: Repayment = {
      id: 'repayment-1',
      updatedAt: at,
      loanId: 'loan-1',
      money: { amount: 500000, currency: 'RUB' },
      date: '2026-09-05',
    }
    const both = data({ loans: [lent], repayments: [back] })
    expect(debtOf(both, BORYA).amounts).toEqual([{ amount: 100000, currency: 'RUB' }])
  })

  it('разные валюты не складываются — две строки, а не одна', () => {
    const usd: Loan = { ...lent, id: 'loan-2', money: { amount: 10000, currency: 'USD' } }
    const both = data({ loans: [lent, usd] })
    expect(debtOf(both, BORYA).amounts).toEqual([
      { amount: 600000, currency: 'RUB' },
      { amount: 10000, currency: 'USD' },
    ])
  })

  it('взял у него столько же, сколько он должен мне по комнате, — выходит ноль и строки нет', () => {
    const borrowed: Loan = {
      ...lent,
      id: 'loan-3',
      direction: 'borrowed',
      money: { amount: 100000, currency: 'RUB' },
    }
    expect(debtOf(data({ loans: [borrowed] }), BORYA).amounts).toEqual([])
  })
})

describe('итог по всем сразу', () => {
  it('мне должны и я должен — два числа, встречные не схлопываются', () => {
    const mixed = data({
      roomSpends: [
        spend({ id: 'spend-1', payerId: ANYA, split: [{ personId: ANYA }, { personId: BORYA }], amount: 200000 }),
      ],
      loans: [
        {
          id: 'loan-1',
          updatedAt: at,
          personId: VERA,
          direction: 'borrowed',
          money: { amount: 300000, currency: 'RUB' },
          date: '2026-08-10',
        },
      ],
    })

    expect(debtTotals(mixed)).toEqual({
      owedToMe: [{ amount: 100000, currency: 'RUB' }],
      owedByMe: [{ amount: 300000, currency: 'RUB' }],
    })
  })

  it('долгов нет — оба списка пусты', () => {
    expect(debtTotals(data({ roomSpends: [] }))).toEqual({ owedToMe: [], owedByMe: [] })
  })
})
