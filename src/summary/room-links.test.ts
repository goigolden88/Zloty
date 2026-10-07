import { describe, expect, it } from 'vitest'
import type { Entry, Room, RoomEvent, RoomSpend, RoomTransfer } from '../app/model.ts'
import type { DebtsData } from '../modules/debts/summary.ts'
import { roomLinks } from './room-links.ts'

/** Люди, комнаты и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'
const ANYA = 'person-anya'
const BORYA = 'person-borya'

const summer: Room = { id: 'room-1', updatedAt: AT, name: 'Лето', currency: 'RUB', personIds: [ANYA, BORYA], closed: true }
const winter: Room = { id: 'room-2', updatedAt: AT, name: 'Зима', currency: 'RUB', personIds: [ANYA, BORYA] }

const event: RoomEvent = { id: 'event-1', updatedAt: AT, roomId: 'room-1', name: 'Корт', date: '2026-09-12', personIds: [ANYA, BORYA] }
const otherEvent: RoomEvent = { ...event, id: 'event-2', roomId: 'room-2', name: 'Каток' }

const spend: RoomSpend = {
  id: 'spend-1',
  updatedAt: AT,
  eventId: 'event-1',
  date: '2026-09-12',
  title: 'Мячи',
  payerId: ANYA,
  amount: 100000,
  split: [{ personId: ANYA }, { personId: BORYA }],
}
const otherSpend: RoomSpend = { ...spend, id: 'spend-2', eventId: 'event-2', title: 'Коньки' }

const transfer: RoomTransfer = {
  id: 'tr-1',
  updatedAt: AT,
  roomId: 'room-1',
  date: '2026-09-20',
  fromId: BORYA,
  toId: ANYA,
  amount: 50000,
}

function debts(over: Partial<DebtsData> = {}): DebtsData {
  return {
    people: [],
    rooms: [summer, winter],
    roomEvents: [event, otherEvent],
    roomSpends: [spend, otherSpend],
    roomTransfers: [transfer],
    loans: [],
    repayments: [],
    ...over,
  }
}

let seq = 0
function entry(refs: string[] | undefined, deleted = false): Entry {
  const out = {
    id: `e-${++seq}`,
    updatedAt: AT,
    kind: 'expense',
    accountId: 'acc',
    date: '2026-09-12',
    money: { amount: 100000, currency: 'RUB' },
  } as Entry
  if (refs) out.refs = refs
  if (deleted) out.deleted = true
  return out
}

describe('связи комнаты с учётом (Р-57)', () => {
  it('связь через трату комнаты — в счёт', () => {
    expect(roomLinks('room-1', [entry(['spend-1'])], debts())).toBe(1)
  })

  it('связь через перевод комнаты — в счёт', () => {
    expect(roomLinks('room-1', [entry(['tr-1'])], debts())).toBe(1)
  })

  it('операция считается раз, сколько бы связей с комнатой у неё ни было', () => {
    expect(roomLinks('room-1', [entry(['spend-1', 'tr-1']), entry(['tr-1'])], debts())).toBe(2)
  })

  it('удалённая операция не в счёт', () => {
    expect(roomLinks('room-1', [entry(['spend-1'], true), entry(['tr-1'], true)], debts())).toBe(0)
  })

  it('связь с тратой чужой комнаты не в счёт', () => {
    expect(roomLinks('room-1', [entry(['spend-2'])], debts())).toBe(0)
    expect(roomLinks('room-2', [entry(['spend-2'])], debts())).toBe(1)
  })

  it('операция без связей и связь в никуда не в счёт', () => {
    expect(roomLinks('room-1', [entry(undefined), entry(['spend-нет'])], debts())).toBe(0)
  })

  it('связь с уже удалённой тратой не в счёт: доля и так не считается', () => {
    expect(roomLinks('room-1', [entry(['spend-1'])], debts({ roomSpends: [{ ...spend, deleted: true }] }))).toBe(0)
  })
})
