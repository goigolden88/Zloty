import { describe, expect, it } from 'vitest'
import type { Currency, Entry, Loan, Person, Room, RoomEvent, RoomSpend, RoomTransfer } from '../app/model.ts'
import type { DebtsData } from '../modules/debts/summary.ts'
import { linkChoices, linkNote } from './links.ts'

/** Люди, комнаты и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'
const RUB: Currency = { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }

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
  date: '2026-08-03',
}

function debts(over: Partial<DebtsData> = {}): DebtsData {
  return {
    people,
    rooms: [room],
    roomEvents: [event],
    roomSpends: [spend],
    roomTransfers: [],
    loans: [loan],
    repayments: [],
    ...over,
  }
}

function entry(refs?: string[]): Entry {
  return {
    id: 'e-1',
    updatedAt: AT,
    kind: 'expense',
    accountId: 'acc',
    money: { amount: 300000, currency: 'RUB' },
    date: '2026-09-12',
    ...(refs ? { refs } : {}),
  }
}

const flat = (value: string) => value.replace(/ | /g, ' ')

describe('с чем можно связать операцию', () => {
  it('траты комнат и долги — разными группами', () => {
    const groups = new Set(linkChoices(debts(), [RUB]).map((each) => each.group))
    expect([...groups].sort()).toEqual(['Долги и возвраты', 'Траты комнат'])
  })

  it('в названии траты — дата, за что, комната и сумма', () => {
    const choice = linkChoices(debts(), [RUB]).find((each) => each.id === 'spend-1')
    expect(flat(choice?.label ?? '')).toBe('12.09.2026 · Ужин · Лето · 3 000,00 ₽')
  })

  it('ближайшее по дате операции стоит первым — за ним и лезут чаще всего', () => {
    const list = linkChoices(debts(), [RUB], '2026-09-12')
    expect(list[0]?.id).toBe('spend-1')
  })

  it('трата комнаты, которой больше нет, в список не попадает', () => {
    expect(linkChoices(debts({ rooms: [] }), [RUB]).some((each) => each.id === 'spend-1')).toBe(false)
  })

  it('удалённое не предлагается', () => {
    const list = linkChoices(debts({ loans: [{ ...loan, deleted: true }] }), [RUB])
    expect(list.some((each) => each.id === 'loan-1')).toBe(false)
  })

  it('переводы комнаты связывать тоже можно: перевод друга приходит на карту', () => {
    const transfer: RoomTransfer = {
      id: 'tr-1',
      updatedAt: AT,
      roomId: 'room-1',
      date: '2026-09-20',
      fromId: BORYA,
      toId: ANYA,
      amount: 100000,
    }
    const choice = linkChoices(debts({ roomTransfers: [transfer] }), [RUB]).find((each) => each.id === 'tr-1')
    expect(flat(choice?.label ?? '')).toBe('20.09.2026 · Боря → Аня · Лето · 1 000,00 ₽')
  })
})

describe('что написано под связанной операцией', () => {
  it('без связи не пишется ничего', () => {
    expect(linkNote(entry(), debts(), [RUB])).toBeNull()
  })

  it('доля вместе с основанием: сколько и за что', () => {
    expect(flat(linkNote(entry(['spend-1']), debts(), [RUB]) ?? '')).toBe(
      'своя доля 1 000,00 ₽ · Ужин, комната «Лето»',
    )
  })

  it('долг в поток не входит, и так и сказано', () => {
    expect(linkNote(entry(['loan-1']), debts(), [RUB])).toBe('дал в долг: Боря · в расход и доход не входит')
  })

  it('связь, ведущая в никуда, называется прямо', () => {
    expect(linkNote(entry(['нет-такого']), debts(), [RUB])).toBe(
      'связь ведёт в никуда: записи больше нет, и в расход операция вошла целиком',
    )
  })

  it('без пометки «это я» доля не выдумывается', () => {
    const noSelf = debts({ people: people.map(({ self: _self, ...rest }) => rest) })
    expect(linkNote(entry(['spend-1']), noSelf, [RUB])).toContain('нет пометки «это я»')
  })
})
