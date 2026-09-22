import { describe, expect, it } from 'vitest'
import modelSource from '../../app/model.ts?raw'
import type { Person, Room, RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import { roomBalances, settle, totalsOf, transfersOf } from './balance.ts'
import { sharesOf } from './split.ts'
import { debtsByPerson, selfOf, type DebtsData } from './summary.ts'

/**
 * Шесть условий Р-01 — тестами, а не обещанием.
 *
 * Вариант Б — участники комнаты пишут в неё по ссылке — отложен, но модель
 * к нему готовится с первого дня. Условия дисциплинируют модель, и держать
 * их должен код, а не память: тип «я — участник с пометкой» не гарантирует,
 * а тест — да.
 *
 * Два условия проверяются сторожем по исходнику. Это не придирка к словам:
 * стоит модулю долгов узнать про операцию или категорию — и комната перестанет
 * вынимать­ся без учёта, то есть перестанет уезжать на сервер отдельно.
 */

const at = '2026-09-22T10:00:00.000Z'
const ANYA = 'person-anya'
const BORYA = 'person-borya'
const VERA = 'person-vera'
const ROOM = 'room-leto'

/**
 * Исходники модуля долгов без тестов, сырым текстом.
 *
 * Через `import.meta.glob`, а не чтением папки: файлы перечисляются сами,
 * и новый файл модуля попадёт под сторож без правки теста — а в проект
 * не приезжает ни одной зависимости ради одной проверки.
 */
function sources(): { name: string; text: string }[] {
  const files = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true })
  return Object.entries(files as Record<string, string>)
    .filter(([name]) => !name.endsWith('.test.ts'))
    .map(([name, text]) => ({ name, text }))
}

/** Объявления долговых типов из модели — от заголовка раздела до хранилищ. */
function debtTypes(): string {
  const from = modelSource.indexOf('// ─── Долги')
  const to = modelSource.indexOf('// ─── Хранилища')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  return modelSource.slice(from, to)
}

const room: Room = { id: ROOM, updatedAt: at, name: 'Лето', currency: 'RUB', personIds: [ANYA, BORYA, VERA] }
const event: RoomEvent = {
  id: 'event-1',
  updatedAt: at,
  roomId: ROOM,
  name: 'Корт',
  date: '2026-08-21',
  personIds: [ANYA, BORYA, VERA],
}
const spend: RoomSpend = {
  id: 'spend-1',
  updatedAt: at,
  eventId: 'event-1',
  date: '2026-08-21',
  title: 'Корт',
  payerId: ANYA,
  amount: 100000,
  split: [{ personId: ANYA }, { personId: BORYA }, { personId: VERA }],
}
const people: Person[] = [
  { id: ANYA, updatedAt: at, name: 'Аня', self: true },
  { id: BORYA, updatedAt: at, name: 'Боря' },
  { id: VERA, updatedAt: at, name: 'Вера' },
]

const data: DebtsData = {
  people,
  rooms: [room],
  roomEvents: [event],
  roomSpends: [spend],
  roomTransfers: [],
  loans: [],
  repayments: [],
}

describe('условие 1 — комната самостоятельна: вынимается целиком, без записей учёта', () => {
  it('всё её ссылается на её id — комната собирается по нему одному', () => {
    const events = [event].filter((each) => each.roomId === room.id)
    const spends = [spend].filter((each) => events.some((own) => own.id === each.eventId))
    const transfers = transfersOf([], room.id)

    expect(events).toHaveLength(1)
    expect(spends).toHaveLength(1)
    expect(transfers).toEqual([])
    expect(roomBalances(room.personIds, spends, transfers).size).toBe(3)
  })

  it('в том, что нужно долгам из базы, записей учёта нет', () => {
    const needed = Object.keys(data)
    expect(needed).not.toContain('entries')
    expect(needed).not.toContain('accounts')
    expect(needed).not.toContain('categories')
  })
})

describe('условие 2 — «я» обычный участник с пометкой', () => {
  it('выборка «мои долги» идёт через пометку, а не через владельца', () => {
    expect(selfOf(people)?.id).toBe(ANYA)
    expect(debtsByPerson({ ...data, people: people.map(({ self: _self, ...rest }) => rest) })).toEqual([])
  })

  it('«я» стоит в составе комнаты наравне с остальными', () => {
    expect(room.personIds).toContain(ANYA)
  })
})

describe('условие 3 — каждая трата и каждый перевод отдельная запись с Base', () => {
  it('у траты и перевода свои id и updatedAt', () => {
    const transfer: RoomTransfer = {
      id: 'transfer-1',
      updatedAt: at,
      roomId: ROOM,
      date: '2026-09-01',
      fromId: BORYA,
      toId: ANYA,
      amount: 100,
    }
    expect(spend.id).not.toBe(transfer.id)
    expect(typeof spend.updatedAt).toBe('string')
    expect(typeof transfer.updatedAt).toBe('string')
  })

  it('два перевода одной пары остаются двумя записями', () => {
    const one: RoomTransfer = {
      id: 'transfer-1',
      updatedAt: at,
      roomId: ROOM,
      date: '2026-09-01',
      fromId: BORYA,
      toId: ANYA,
      amount: 100,
    }
    const two: RoomTransfer = { ...one, id: 'transfer-2', amount: 200 }
    expect(transfersOf([one, two], ROOM)).toHaveLength(2)
  })
})

describe('условие 4 — долги, итоги и минимизация считаются, не хранятся', () => {
  it('в долговых типах нет полей с посчитанным', () => {
    const types = debtTypes()
    // Имя поля, а не подстрока: 'borrowed' — законное значение `direction`,
    // и сторож, ловящий его как «owed», сторожил бы не то.
    const fields = [...types.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1])
    for (const posted of ['balance', 'balances', 'owed', 'net', 'total', 'left', 'settled']) {
      expect(fields).not.toContain(posted)
    }
    expect(fields).toContain('amount')
  })

  it('новая трата меняет итог, не трогая прежние записи', () => {
    const before = roomBalances(room.personIds, [spend], [])
    const more: RoomSpend = { ...spend, id: 'spend-2', payerId: BORYA, amount: 300000 }
    const after = roomBalances(room.personIds, [spend, more], [])

    expect(before.get(BORYA)).toBe(-33333)
    expect(after.get(BORYA)).toBe(166667)
    expect(spend.amount).toBe(100000)
  })

  it('минимизация возвращает подсказку, а не пишет переводы', () => {
    const lines = settle(roomBalances(room.personIds, [spend], []))
    expect(lines.every((line) => !('id' in line))).toBe(true)
  })
})

describe('условие 5 — учёт читает комнату, а не наоборот', () => {
  it('модуль долгов не знает про операции, счета и категории', () => {
    for (const { name, text } of sources()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const word of ['Entry', 'categoryId', 'accountId', 'Account', 'Category']) {
        expect(`${name}: ${code}`).not.toContain(word)
      }
    }
  })

  it('исходники модуля вообще нашлись — сторож не проходит на пустоте', () => {
    expect(sources().length).toBeGreaterThanOrEqual(4)
  })
})

describe('условие 6 — суммы целые в минимальных единицах', () => {
  it('доли, итоги, балансы и переводы — целые даже на неделящейся сумме', () => {
    const shares = sharesOf(spend)
    expect([...shares.values()].every(Number.isInteger)).toBe(true)
    expect(totalsOf([spend]).every((each) => Number.isInteger(each.net))).toBe(true)

    const balances = roomBalances(room.personIds, [spend], [])
    expect([...balances.values()].every(Number.isInteger)).toBe(true)
    expect(settle(balances).every((line) => Number.isInteger(line.amount))).toBe(true)
  })
})
