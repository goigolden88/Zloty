import { describe, expect, it } from 'vitest'
import type { Currency, Person, RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import { roomText } from './text.ts'

/** Люди и комната выдуманные: код публичный (CLAUDE.md). */
const at = '2026-09-22T10:00:00.000Z'
const ANYA = 'person-anya'
const BORYA = 'person-borya'

const people: Person[] = [
  { id: ANYA, updatedAt: at, name: 'Аня', self: true },
  { id: BORYA, updatedAt: at, name: 'Боря' },
]

const rub: Currency = { id: 'currency-rub', updatedAt: at, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }

const event: RoomEvent = {
  id: 'event-1',
  updatedAt: at,
  roomId: 'room-leto',
  name: 'Корт',
  date: '2026-08-21',
  personIds: [ANYA, BORYA],
}

const spend: RoomSpend = {
  id: 'spend-1',
  updatedAt: at,
  eventId: 'event-1',
  date: '2026-08-21',
  title: 'Мячи',
  payerId: ANYA,
  amount: 100000,
  split: [{ personId: ANYA }, { personId: BORYA }],
}

/** Неразрывные пробелы формата денег — не то, что проверяют эти тесты. */
const flat = (value: string) => value.replace(/ /g, ' ')

function text(over: { transfers?: RoomTransfer[] } = {}): string {
  return flat(
    roomText({
    name: 'Лето',
    personIds: [ANYA, BORYA],
    people,
    events: [event],
    spends: [spend],
    transfers: over.transfers ?? [],
      code: 'RUB',
      currency: rub,
    }),
  )
}

describe('итог комнаты текстом — снимок, который уходит друзьям (Р-01, вариант А)', () => {
  it('называет комнату, потраченное и основание — сколько событий и трат', () => {
    const out = text()
    expect(out).toContain('Лето — кто кому должен')
    expect(out).toContain('Потрачено всего 1 000,00 ₽')
    expect(out).toContain('1 событие')
    expect(out).toContain('1 трата')
  })

  it('итог по каждому участнику, включая того, кому платить', () => {
    const out = text()
    expect(out).toContain('— Аня: получит 500,00 ₽')
    expect(out).toContain('— Боря: должен 500,00 ₽')
  })

  it('переводы, которые всё закрывают, названы поимённо', () => {
    expect(text()).toContain('— Боря → Аня: 500,00 ₽')
  })

  it('все в расчёте — так и сказано, а не пустой список', () => {
    const paid: RoomTransfer = {
      id: 'transfer-1',
      updatedAt: at,
      roomId: 'room-leto',
      date: '2026-09-01',
      fromId: BORYA,
      toId: ANYA,
      amount: 50000,
    }
    const out = text({ transfers: [paid] })
    expect(out).toContain('Переводить нечего: все в расчёте.')
    expect(out).toContain('— Аня: в расчёте')
  })

  it('уже сделанные переводы перечислены с датой и банком, если он назван', () => {
    const paid: RoomTransfer = {
      id: 'transfer-1',
      updatedAt: at,
      roomId: 'room-leto',
      date: '2026-09-01',
      fromId: BORYA,
      toId: ANYA,
      amount: 50000,
      note: 'на Сбер',
    }
    const out = text({ transfers: [paid] })
    expect(out).toContain('Уже перевели:')
    expect(out).toContain('на Сбер')
    expect(out).toContain('1 сентября 2026')
  })

  it('склонения не ломаются на других числах', () => {
    const many = flat(
      roomText({
      name: 'Лето',
      personIds: [ANYA, BORYA],
      people,
      events: [event, { ...event, id: 'event-2' }, { ...event, id: 'event-3' }, { ...event, id: 'event-4' }, { ...event, id: 'event-5' }],
      spends: [spend, { ...spend, id: 'spend-2' }],
      transfers: [],
        code: 'RUB',
        currency: rub,
      }),
    )
    expect(many).toContain('5 событий')
    expect(many).toContain('2 траты')
  })
})
