import { describe, expect, it } from 'vitest'
import type { RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import { eventsOf, roomBalances, settle, spendsOf, spentTotal, totalsOf, transfersOf } from './balance.ts'

/** Люди и комнаты выдуманные: код публичный (CLAUDE.md). */
const ANYA = 'person-anya'
const BORYA = 'person-borya'
const VERA = 'person-vera'
const GLEB = 'person-gleb'
const ROOM = 'room-leto'

function spend(over: Partial<RoomSpend> & { id: string }): RoomSpend {
  return {
    updatedAt: '2026-09-22T10:00:00.000Z',
    eventId: 'event-1',
    date: '2026-08-21',
    title: 'Корт',
    payerId: ANYA,
    amount: 300000,
    split: [{ personId: ANYA }, { personId: BORYA }, { personId: VERA }],
    ...over,
  }
}

function transfer(over: Partial<RoomTransfer> & { id: string }): RoomTransfer {
  return {
    updatedAt: '2026-09-22T10:00:00.000Z',
    roomId: ROOM,
    date: '2026-09-01',
    fromId: BORYA,
    toId: ANYA,
    amount: 100000,
    ...over,
  }
}

function event(over: Partial<RoomEvent> & { id: string }): RoomEvent {
  return {
    updatedAt: '2026-09-22T10:00:00.000Z',
    roomId: ROOM,
    name: 'Корт',
    date: '2026-08-21',
    personIds: [ANYA, BORYA, VERA],
    ...over,
  }
}

const zero = (balances: Map<string, number>) => [...balances.values()].reduce((a, b) => a + b, 0)

describe('итог события: кто внёс и кто потратил на себя', () => {
  it('заплатил один за всех — ему должны, остальные должны', () => {
    const totals = totalsOf([spend({ id: 's1' })])
    const anya = totals.find((each) => each.personId === ANYA)
    const borya = totals.find((each) => each.personId === BORYA)

    expect(anya).toEqual({ personId: ANYA, paid: 300000, personal: 100000, net: 200000 })
    expect(borya).toEqual({ personId: BORYA, paid: 0, personal: 100000, net: -100000 })
  })

  it('заплатил один, а доля целиком у другого — как в образце', () => {
    const totals = totalsOf([
      spend({ id: 's1', amount: 70000, payerId: ANYA, split: [{ personId: BORYA }] }),
    ])
    expect(totals.find((each) => each.personId === ANYA)?.net).toBe(70000)
    expect(totals.find((each) => each.personId === BORYA)?.net).toBe(-70000)
  })

  it('в итоге называются только те, кто платил или на кого делили', () => {
    const totals = totalsOf([spend({ id: 's1', split: [{ personId: ANYA }, { personId: BORYA }] })])
    expect(totals.map((each) => each.personId).sort()).toEqual([ANYA, BORYA].sort())
  })

  it('потрачено всего — сумма трат', () => {
    expect(spentTotal([spend({ id: 's1' }), spend({ id: 's2', amount: 50000 })])).toBe(350000)
  })
})

describe('баланс комнаты считается, а не хранится (условие 4 Р-01)', () => {
  it('сумма всех балансов — ноль: деньги не появляются и не исчезают', () => {
    const balances = roomBalances([ANYA, BORYA, VERA, GLEB], [spend({ id: 's1', amount: 100000 })], [])
    expect(zero(balances)).toBe(0)
  })

  it('участник, который ни в чём не участвовал, называется нулём, а не пропадает', () => {
    const balances = roomBalances([ANYA, BORYA, VERA, GLEB], [spend({ id: 's1' })], [])
    expect(balances.get(GLEB)).toBe(0)
    expect(balances.has(GLEB)).toBe(true)
  })

  it('перевод закрывает долг: перевёл — баланс вырос', () => {
    const spends = [spend({ id: 's1' })]
    const before = roomBalances([ANYA, BORYA, VERA], spends, [])
    expect(before.get(BORYA)).toBe(-100000)

    const after = roomBalances([ANYA, BORYA, VERA], spends, [transfer({ id: 't1' })])
    expect(after.get(BORYA)).toBe(0)
    expect(after.get(ANYA)).toBe(100000)
    expect(zero(after)).toBe(0)
  })

  it('два перевода между теми же людьми не склеиваются (условие 3 Р-01)', () => {
    const two = [transfer({ id: 't1', amount: 40000 }), transfer({ id: 't2', amount: 60000 })]
    expect(transfersOf(two, ROOM)).toHaveLength(2)
    const balances = roomBalances([ANYA, BORYA], [spend({ id: 's1' })], two)
    expect(balances.get(BORYA)).toBe(0)
  })

  it('удалённые траты и переводы не считаются', () => {
    const balances = roomBalances(
      [ANYA, BORYA, VERA],
      [spend({ id: 's1' })],
      [transfer({ id: 't1', deleted: true })],
    )
    expect(balances.get(BORYA)).toBe(-100000)
  })
})

describe('выборка по комнате и событию', () => {
  it('события — только своей комнаты, траты — только своего события', () => {
    const events = [event({ id: 'e1' }), event({ id: 'e2', roomId: 'room-other' })]
    expect(eventsOf(events, ROOM).map((each) => each.id)).toEqual(['e1'])

    const spends = [spend({ id: 's1', eventId: 'e1' }), spend({ id: 's2', eventId: 'e2' })]
    expect(spendsOf(spends, 'e1').map((each) => each.id)).toEqual(['s1'])
  })

  it('удалённое событие в комнату не входит', () => {
    expect(eventsOf([event({ id: 'e1', deleted: true })], ROOM)).toEqual([])
  })
})

describe('кто кому переводит — минимизация (Р-01, Р-30)', () => {
  it('один должник и один получатель — один перевод', () => {
    const lines = settle(new Map([[ANYA, 100000], [BORYA, -100000]]))
    expect(lines).toEqual([{ fromId: BORYA, toId: ANYA, amount: 100000 }])
  })

  it('двое должны одному — два перевода, и каждый закрывает свой долг', () => {
    const lines = settle(new Map([[ANYA, 200000], [BORYA, -100000], [VERA, -100000]]))
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.toId === ANYA)).toBe(true)
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(200000)
  })

  it('переводов не больше, чем участников без одного', () => {
    const lines = settle(
      new Map([[ANYA, 150000], [BORYA, 50000], [VERA, -120000], [GLEB, -80000]]),
    )
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(200000)
  })

  it('после переводов все выходят в ноль', () => {
    const balances = new Map([[ANYA, 150000], [BORYA, 50000], [VERA, -120000], [GLEB, -80000]])
    const after = new Map(balances)
    for (const line of settle(balances)) {
      after.set(line.fromId, (after.get(line.fromId) ?? 0) + line.amount)
      after.set(line.toId, (after.get(line.toId) ?? 0) - line.amount)
    }
    expect([...after.values()].every((each) => each === 0)).toBe(true)
  })

  it('ответ не зависит от порядка записей — на всех устройствах он один', () => {
    const forward = settle(new Map([[ANYA, 150000], [BORYA, 50000], [VERA, -120000], [GLEB, -80000]]))
    const backward = settle(new Map([[GLEB, -80000], [VERA, -120000], [BORYA, 50000], [ANYA, 150000]]))
    expect(backward).toEqual(forward)
  })

  it('все в нуле — переводить нечего', () => {
    expect(settle(new Map([[ANYA, 0], [BORYA, 0]]))).toEqual([])
  })

  it('суммы переводов целые — копейка не дробится', () => {
    const lines = settle(new Map([[ANYA, 33334], [BORYA, -33333], [VERA, -1]]))
    expect(lines.every((line) => Number.isInteger(line.amount))).toBe(true)
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(33334)
  })
})
