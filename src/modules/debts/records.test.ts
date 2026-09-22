import { describe, expect, it } from 'vitest'
import type { Loan, Person, Room } from '../../app/model.ts'
import {
  createLoan,
  createPerson,
  createRepayment,
  createRoom,
  createTransfer,
  eventProblem,
  nameOf,
  personProblem,
  removed,
  roomProblem,
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

  it('архивные из списка уходят, а имя по id всё равно находится', () => {
    const gone = { ...borya, archived: true }
    expect(sortedPeople([anya, gone])).toHaveLength(1)
    expect(nameOf([anya, gone], gone.id)).toBe('Боря')
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
