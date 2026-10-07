import { describe, expect, it } from 'vitest'
import type { Loan, Person, Room, RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import {
  createLoan,
  createPerson,
  createRepayment,
  createRoom,
  createTransfer,
  eventProblem,
  nameOf,
  orderedIds,
  personProblem,
  removed,
  roomProblem,
  roomRemoval,
  setClosed,
  sortedPeople,
  transferProblem,
  updatePerson,
  updateRoom,
} from './records.ts'

/** Люди и комнаты выдуманные: код публичный (CLAUDE.md). */
const at = '2026-09-22T10:00:00.000Z'
const anya: Person = { id: 'person-anya', updatedAt: at, name: 'Аня', self: true }
const borya: Person = { id: 'person-borya', updatedAt: at, name: 'Боря' }

describe('люди: пометка «я» одна на справочник (условие 2 Р-01)', () => {
  it('имя обязательно и чистится от лишних пробелов', () => {
    expect(personProblem([], { name: '   ', self: false })).toBe('Без имени человека не завести')
    expect(createPerson({ name: '  Вера   Ивановна ', self: false }).name).toBe('Вера Ивановна')
  })

  it('тёзка не заводится — иначе долги разъедутся по двум записям', () => {
    expect(personProblem([borya], { name: 'боря', self: false })).toBe('Такой человек уже есть')
  })

  it('вторая пометка «я» не ставится, и сказано, на ком стоит первая', () => {
    expect(personProblem([anya], { name: 'Боря', self: true })).toBe('Пометка «это я» уже стоит на «Аня»')
  })

  it('себя же правя, на свою пометку не жалуется', () => {
    expect(personProblem([anya], { name: 'Аня', self: true }, anya.id)).toBeNull()
  })

  it('удалённый тёзка не мешает', () => {
    expect(personProblem([{ ...borya, deleted: true }], { name: 'Боря', self: false })).toBeNull()
  })

  it('правка не теряет архив', () => {
    const archived = { ...borya, archived: true }
    expect(updatePerson(archived, { name: 'Боря', self: false }).archived).toBe(true)
  })

  it('в списке «я» идёт первым, остальные по алфавиту', () => {
    const vera: Person = { id: 'person-vera', updatedAt: at, name: 'Вера' }
    expect(sortedPeople([vera, borya, anya]).map((each) => each.name)).toEqual(['Аня', 'Боря', 'Вера'])
  })

  it('без важных порядок прежний: «я» первым, даже если по алфавиту не первый', () => {
    const yulia: Person = { id: 'person-yulia', updatedAt: at, name: 'Юля', self: true }
    const vera: Person = { id: 'person-vera', updatedAt: at, name: 'Вера' }
    expect(sortedPeople([vera, yulia, borya]).map((each) => each.name)).toEqual(['Юля', 'Боря', 'Вера'])
  })

  it('архивные из списка уходят, а имя по id всё равно находится', () => {
    const gone = { ...borya, archived: true }
    expect(sortedPeople([anya, gone])).toHaveLength(1)
    expect(nameOf([anya, gone], gone.id)).toBe('Боря')
  })

  it('пометка «важный» записывается и снимается правкой (Р-56)', () => {
    expect(createPerson({ name: 'Боря', self: false, starred: true }).starred).toBe(true)
    expect(createPerson({ name: 'Боря', self: false }).starred).toBeUndefined()
    const starred: Person = { ...borya, starred: true }
    expect(updatePerson(starred, { name: 'Боря', self: false, starred: false }).starred).toBeUndefined()
  })

  it('важные — сразу за «я», каждые по алфавиту (Р-56)', () => {
    const yulia: Person = { id: 'person-yulia', updatedAt: at, name: 'Юля', self: true }
    const vera: Person = { id: 'person-vera', updatedAt: at, name: 'Вера' }
    const gleb: Person = { id: 'person-gleb', updatedAt: at, name: 'Глеб', starred: true }
    const yasha: Person = { id: 'person-yasha', updatedAt: at, name: 'Яша', starred: true }
    expect(sortedPeople([yasha, vera, borya, gleb, yulia]).map((each) => each.name)).toEqual([
      'Юля',
      'Глеб',
      'Яша',
      'Боря',
      'Вера',
    ])
  })

  it('архивный важный остаётся скрытым (Р-56)', () => {
    const gone: Person = { ...borya, starred: true, archived: true }
    expect(sortedPeople([anya, gone]).map((each) => each.name)).toEqual(['Аня'])
  })

  it('состав комнаты в выборе идёт тем же порядком, архивный — в конце, а не пропадает (Р-56)', () => {
    const vera: Person = { id: 'person-vera', updatedAt: at, name: 'Вера', starred: true }
    const gone: Person = { id: 'person-gone', updatedAt: at, name: 'Агата', archived: true }
    const ids = [borya.id, gone.id, vera.id, anya.id]
    expect(orderedIds([anya, borya, vera, gone], ids)).toEqual([anya.id, vera.id, borya.id, gone.id])
  })

  it('имя исчезнувшего называется словами, а не пустотой', () => {
    expect(nameOf([anya], 'person-nobody')).toBe('кто-то удалённый')
  })
})

describe('комнаты', () => {
  const room: Room = {
    id: 'room-leto',
    updatedAt: at,
    name: 'Лето',
    currency: 'RUB',
    personIds: [anya.id, borya.id],
  }

  it('комната одного человека бессмысленна', () => {
    expect(roomProblem([], { name: 'Лето', currency: 'RUB', personIds: [anya.id] })).toBe(
      'В комнате должно быть хотя бы двое',
    )
  })

  it('без валюты не завести: суммы внутри целые именно в ней', () => {
    expect(roomProblem([], { name: 'Лето', currency: '', personIds: [anya.id, borya.id] })).toBe(
      'Не выбрана валюта комнаты',
    )
  })

  it('название не повторяется', () => {
    expect(roomProblem([room], { name: 'лето', currency: 'RUB', personIds: [anya.id, borya.id] })).toBe(
      'Комната с таким названием уже есть',
    )
  })

  it('валюта заведённой комнаты не меняется правкой — суммы уже записаны в ней', () => {
    const next = updateRoom(room, { name: 'Лето', currency: 'USD', personIds: [anya.id, borya.id] })
    expect(next.currency).toBe('RUB')
  })

  it('закрытие и открытие заново', () => {
    const closed = setClosed(room, true)
    expect(closed.closed).toBe(true)
    expect(setClosed(closed, false).closed).toBeUndefined()
  })

  it('заведение чистит название и копирует состав, а не держит чужой массив', () => {
    const people = [anya.id, borya.id]
    const made = createRoom({ name: '  Лето  ', currency: 'RUB', personIds: people })
    people.push('person-vera')
    expect(made.name).toBe('Лето')
    expect(made.personIds).toEqual([anya.id, borya.id])
  })
})

describe('события и переводы', () => {
  it('событие без участников не заводится: «поровну» не на кого делить', () => {
    expect(eventProblem({ name: 'Корт', date: '2026-08-21', personIds: [] })).toBe(
      'В событии нет ни одного участника',
    )
  })

  it('событию нужны название и дата', () => {
    expect(eventProblem({ name: ' ', date: '2026-08-21', personIds: [anya.id] })).toBe(
      'Без названия событие не завести',
    )
    expect(eventProblem({ name: 'Корт', date: '', personIds: [anya.id] })).toBe('Не указана дата события')
  })

  it('перевод самому себе ничего не меняет', () => {
    expect(
      transferProblem({ fromId: anya.id, toId: anya.id, amount: 100, date: '2026-09-01' }),
    ).toBe('Перевод самому себе ничего не меняет')
  })

  it('сумма перевода целая и больше нуля', () => {
    expect(transferProblem({ fromId: anya.id, toId: borya.id, amount: 0, date: '2026-09-01' })).toBe(
      'Сумма перевода должна быть больше нуля',
    )
  })

  it('банк перевода — необязательная заметка; пустая не пишется', () => {
    const withBank = createTransfer('room-leto', {
      fromId: borya.id,
      toId: anya.id,
      amount: 100,
      date: '2026-09-01',
      note: ' на Сбер ',
    })
    expect(withBank.note).toBe('на Сбер')

    const without = createTransfer('room-leto', {
      fromId: borya.id,
      toId: anya.id,
      amount: 100,
      date: '2026-09-01',
      note: '   ',
    })
    expect('note' in without).toBe(false)
  })
})

describe('разовые долги', () => {
  it('заведение кладёт свою копию суммы', () => {
    const money = { amount: 500000, currency: 'RUB' }
    const loan = createLoan({ personId: borya.id, direction: 'lent', money, date: '2026-08-10' })
    money.amount = 1
    expect(loan.money.amount).toBe(500000)
  })

  it('возврат привязан к долгу и несёт свою дату', () => {
    const back = createRepayment('loan-1', { amount: 200000, currency: 'RUB' }, '2026-09-01')
    expect(back.loanId).toBe('loan-1')
    expect(back.date).toBe('2026-09-01')
  })
})

describe('удаление мягкое — иначе запись воскресит синхронизация', () => {
  it('запись остаётся надгробием', () => {
    const loan: Loan = {
      id: 'loan-1',
      updatedAt: at,
      personId: borya.id,
      direction: 'lent',
      money: { amount: 100, currency: 'RUB' },
      date: '2026-08-10',
    }
    const gone = removed(loan)
    expect(gone.deleted).toBe(true)
    expect(gone.id).toBe(loan.id)
    expect(gone.updatedAt > loan.updatedAt).toBe(true)
  })
})

describe('удаление комнаты (Р-57)', () => {
  const room: Room = { id: 'room-1', updatedAt: at, name: 'Лето', currency: 'RUB', personIds: [anya.id, borya.id], closed: true }
  const other: Room = { ...room, id: 'room-2', name: 'Зима' }
  const event: RoomEvent = { id: 'event-1', updatedAt: at, roomId: 'room-1', name: 'Корт', date: '2026-08-21', personIds: [anya.id, borya.id] }
  const gone: RoomEvent = { ...event, id: 'event-old', deleted: true }
  const foreign: RoomEvent = { ...event, id: 'event-2', roomId: 'room-2' }
  const spend: RoomSpend = {
    id: 'spend-1',
    updatedAt: at,
    eventId: 'event-1',
    date: '2026-08-21',
    title: 'Мячи',
    payerId: anya.id,
    amount: 100000,
    split: [{ personId: anya.id }, { personId: borya.id }],
  }
  const orphan: RoomSpend = { ...spend, id: 'spend-orphan', eventId: 'event-old' }
  const foreignSpend: RoomSpend = { ...spend, id: 'spend-2', eventId: 'event-2' }
  const transfer: RoomTransfer = { id: 'tr-1', updatedAt: at, roomId: 'room-1', date: '2026-08-22', fromId: borya.id, toId: anya.id, amount: 50000 }
  const foreignTransfer: RoomTransfer = { ...transfer, id: 'tr-2', roomId: 'room-2' }
  const loan: Loan = {
    id: 'loan-1',
    updatedAt: at,
    personId: borya.id,
    direction: 'lent',
    money: { amount: 100, currency: 'RUB' },
    date: '2026-08-10',
  }

  const data = {
    people: [anya, borya],
    rooms: [room, other],
    roomEvents: [event, gone, foreign],
    roomSpends: [spend, orphan, foreignSpend],
    roomTransfers: [transfer, foreignTransfer],
    loans: [loan],
    repayments: [],
  }

  it('надгробие — комнате, её событиям, тратам и переводам', () => {
    const out = roomRemoval(room, data)
    expect(out.room).toMatchObject({ id: 'room-1', deleted: true })
    expect(out.events.map((each) => each.id)).toEqual(['event-1'])
    expect(out.spends.map((each) => each.id)).toEqual(['spend-1', 'spend-orphan'])
    expect(out.transfers.map((each) => each.id)).toEqual(['tr-1'])
    expect([...out.events, ...out.spends, ...out.transfers].every((each) => each.deleted)).toBe(true)
  })

  it('чужую комнату, людей и разовые долги не трогает', () => {
    const out = roomRemoval(room, data)
    const ids = [out.room, ...out.events, ...out.spends, ...out.transfers].map((each) => each.id)
    for (const untouched of ['room-2', 'event-2', 'spend-2', 'tr-2', 'loan-1', anya.id, borya.id]) {
      expect(ids).not.toContain(untouched)
    }
    // Исходные записи не изменены: надгробия — новые записи.
    expect(room.deleted).toBeUndefined()
    expect(loan.deleted).toBeUndefined()
    expect(anya.deleted).toBeUndefined()
  })

  it('уже удалённое заново не пишется', () => {
    expect(roomRemoval(room, data).events.map((each) => each.id)).not.toContain('event-old')
  })
})
