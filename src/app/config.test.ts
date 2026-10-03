import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../shared/core/db.ts'
import { createLayout } from '../shared/core/layout.ts'
import { checkConfig, LOCAL_STORES } from '../shared/core/model.ts'
import { config } from './config.ts'
import {
  DEBT_STORES,
  NOTE_STORES,
  SPECIAL_STORES,
  entryDate,
  SCHEMA_VERSION,
  SYNCED_STORES,
  V1_STORES,
  type Entry,
  type Note,
  type Person,
  type SpecialPeriod,
  type StoreRecord,
} from './model.ts'

/**
 * Сторож конфига «Злотых».
 *
 * Механику ядра проверяют его тесты в его CI (Р-52 «Трапезы»). Здесь — своё:
 * то, что после первого релиза лежит на устройствах и в `ZlotyData` и не
 * меняется никогда, — имя базы, состав `v1Stores`, индексы и раскладка.
 * Тест падает, если их поменяли молча.
 */

const db = createDb(config)
const layout = createLayout(config)

/** Пустой слепок всех хранилищ: раскладке нужны все ключи разом. */
function empty(): { [S in keyof StoreRecord]: StoreRecord[S][] } {
  const data = {} as { [S in keyof StoreRecord]: StoreRecord[S][] }
  for (const store of SYNCED_STORES) data[store] = []
  return data
}

beforeEach(async () => {
  await db.close().catch(() => {})
  globalThis.indexedDB = new IDBFactory()
})

afterEach(async () => {
  await db.close().catch(() => {})
})

describe('то, что не меняется после первого релиза', () => {
  it('база называется zloty — на общем origin только имя разводит приложения семьи', () => {
    expect(config.dbName).toBe('zloty')
  })

  it('раскладка версии 1 — те же восемь хранилищ, что были при релизе', () => {
    expect([...V1_STORES]).toEqual([
      'profile',
      'currencies',
      'accounts',
      'categories',
      'recurring',
      'rates',
      'entries',
      'balances',
    ])
    expect([...config.v1Stores]).toEqual([...V1_STORES])
  })

  it('долги, заметки и особые периоды дописаны к хранилищам, а не в раскладку версии 1', () => {
    expect([...config.stores]).toEqual([...V1_STORES, ...DEBT_STORES, ...NOTE_STORES, ...SPECIAL_STORES])
    expect([...config.stores]).toHaveLength(17)
    for (const store of [...DEBT_STORES, ...NOTE_STORES, ...SPECIAL_STORES]) {
      expect(V1_STORES as readonly string[]).not.toContain(store)
    }
  })

  it('формат импорта — zloty-import: его знают файлы, написанные беседой', () => {
    expect(config.importFormat).toBe('zloty-import')
  })

  it('конфиг сходится по проверке ядра', () => {
    expect(() => checkConfig(config)).not.toThrow()
  })

  it('имена хранилищ не сталкиваются с локальными хранилищами ядра', () => {
    for (const store of config.stores) {
      expect(LOCAL_STORES as readonly string[]).not.toContain(store)
    }
  })
})

describe('миграции: версия 2 — долги (Р-30), 3 — заметки (Р-36), 4 — особые периоды (Р-55)', () => {
  it('версия схемы 4, шагов три, все только добавляют', () => {
    expect(config.schemaVersion).toBe(4)
    expect(SCHEMA_VERSION).toBe(4)
    expect(config.migrations.map((step) => step.to)).toEqual([2, 3, 4])
    expect(config.migrations.every((step) => step.additive === true)).toBe(true)
  })

  it('свежая база доезжает до версии 4: все семнадцать хранилищ есть и пусты', async () => {
    for (const store of config.stores) {
      expect(await db.count(store)).toBe(0)
    }
  })

  it('свежая база принимает особый период: хранилище specials заведено', async () => {
    const trip: SpecialPeriod = {
      id: '01J000000000000000000007',
      updatedAt: '2026-10-03T10:00:00.000Z',
      from: '2026-07-10',
      to: '2026-07-20',
      title: 'Поездка',
    }
    await db.put('specials', trip)
    // `put` ставит своё время правки — сравнивается всё, кроме него.
    expect(await db.getAll('specials')).toEqual([{ ...trip, updatedAt: expect.any(String) }])
  })

  it('база версии 1 с записями открывается версией 4: учёт цел, новые хранилища пусты', async () => {
    const operation: Entry = {
      id: '01J000000000000000000001',
      updatedAt: '2026-09-20T10:00:00.000Z',
      kind: 'expense',
      accountId: 'account-1',
      money: { amount: 12300, currency: 'RUB' },
      date: '2026-08-14',
    }

    const skipped = await db.createLegacyBase(1, { entries: [operation] })
    expect(skipped).toEqual([])

    expect(await db.getAll('entries')).toEqual([operation])
    for (const store of [...DEBT_STORES, ...NOTE_STORES, ...SPECIAL_STORES]) {
      expect(await db.count(store)).toBe(0)
    }
  })

  it('база версии 2 с долгами открывается версией 4: долги целы, заметок и периодов нет', async () => {
    const person: Person = { id: '01J000000000000000000002', updatedAt: '2026-09-20T10:00:00.000Z', name: 'Петя' }

    const skipped = await db.createLegacyBase(2, { people: [person] })
    expect(skipped).toEqual([])

    expect(await db.getAll('people')).toEqual([person])
    expect(await db.count('notes')).toBe(0)
    expect(await db.count('specials')).toBe(0)
  })

  it('база версии 3 с записями открывается версией 4: записи на месте, флаг особой цел, specials пусто', async () => {
    const odd: Entry = {
      id: '01J000000000000000000008',
      updatedAt: '2026-09-20T10:00:00.000Z',
      kind: 'expense',
      accountId: 'account-1',
      money: { amount: 900000, currency: 'RUB' },
      date: '2026-08-14',
      special: true,
    }
    const usual: Entry = {
      id: '01J000000000000000000009',
      updatedAt: '2026-09-20T10:00:00.000Z',
      kind: 'expense',
      accountId: 'account-1',
      money: { amount: 12300, currency: 'RUB' },
      date: '2026-08-15',
    }
    const person: Person = { id: '01J000000000000000000002', updatedAt: '2026-09-20T10:00:00.000Z', name: 'Петя' }
    const note: Note = {
      id: '01J000000000000000000005',
      updatedAt: '2026-09-22T10:00:00.000Z',
      about: 'capital',
      date: '2026-03-02',
      text: 'просадка',
    }

    const skipped = await db.createLegacyBase(3, { entries: [odd, usual], people: [person], notes: [note] })
    expect(skipped).toEqual([])

    expect(await db.getAll('entries')).toEqual([odd, usual])
    expect(await db.getAll('people')).toEqual([person])
    expect(await db.getAll('notes')).toEqual([note])
    expect(await db.count('specials')).toBe(0)
  })

  it('слепок, выгруженный на версиях 1–3, приложение принимает: шаги только добавляют', () => {
    expect(() => db.checkSnapshotVersion(1)).not.toThrow()
    expect(() => db.checkSnapshotVersion(2)).not.toThrow()
    expect(() => db.checkSnapshotVersion(3)).not.toThrow()
    expect(() => db.checkSnapshotVersion(4)).not.toThrow()
  })
})

describe('индексы — те, по которым идут выборки', () => {
  it('месяц читается по дате, повтор импорта ловится по ext, история счёта — по accountId', () => {
    expect([...config.indexes.entries]).toEqual(['date', 'ext', 'accountId'])
    expect([...config.indexes.balances]).toEqual(['date', 'accountId'])
    expect([...config.indexes.rates]).toEqual(['date'])
  })

  it('справочники читаются целиком — своих индексов у них нет', () => {
    expect([...config.indexes.profile]).toEqual([])
    expect([...config.indexes.currencies]).toEqual([])
    expect([...config.indexes.accounts]).toEqual([])
    expect([...config.indexes.categories]).toEqual([])
    expect([...config.indexes.recurring]).toEqual([])
  })

  it('долгам, заметкам и особым периодам индексов не заводили: читать по ним ядро всё равно не умеет', () => {
    for (const store of [...DEBT_STORES, ...NOTE_STORES, ...SPECIAL_STORES]) {
      expect([...config.indexes[store]]).toEqual([])
    }
  })
})

describe('раскладка по файлам', () => {
  it('справочники — одним файлом, записи — по месяцам', () => {
    expect(config.places.accounts).toEqual({ split: 'none', path: 'accounts.json' })
    expect(config.places.profile).toEqual({ split: 'none', path: 'profile.json' })
    expect(config.places.entries.split).toBe('month')
    expect(config.places.balances.split).toBe('month')
    expect(config.places.rates.split).toBe('month')
  })

  it('люди и комнаты — справочники; событие, трата, перевод, долг и возврат — по месяцам', () => {
    expect(config.places.people).toEqual({ split: 'none', path: 'people.json' })
    expect(config.places.rooms).toEqual({ split: 'none', path: 'rooms.json' })
    expect(config.places.roomEvents.split).toBe('month')
    expect(config.places.roomSpends.split).toBe('month')
    expect(config.places.roomTransfers.split).toBe('month')
    expect(config.places.loans.split).toBe('month')
    expect(config.places.repayments.split).toBe('month')
  })

  it('операция ложится в месяц своей даты, итог периода — в месяц конца периода', () => {
    const operation: Entry = {
      id: '01J000000000000000000001',
      updatedAt: '2026-09-20T10:00:00.000Z',
      kind: 'expense',
      accountId: 'account-1',
      money: { amount: 12300, currency: 'RUB' },
      date: '2026-08-14',
    }
    const total: Entry = {
      id: '01J000000000000000000002',
      updatedAt: '2026-09-20T10:00:00.000Z',
      kind: 'expense',
      accountId: 'account-history',
      money: { amount: 4560000, currency: 'RUB' },
      period: { from: '2025-12-11', to: '2026-01-11' },
    }

    expect(entryDate(operation)).toBe('2026-08-14')
    expect(entryDate(total)).toBe('2026-01-11')

    const files = layout.buildFiles({ ...empty(), entries: [operation, total] })
    const paths = files.map((file) => file.path)
    expect(paths).toContain('entries/2026-08.json')
    expect(paths).toContain('entries/2026-01.json')
  })

  it('заметка к капиталу ложится в месяц своей даты (Р-36)', () => {
    expect(config.places.notes.split).toBe('month')
    const files = layout.buildFiles({
      ...empty(),
      notes: [{ id: '01J000000000000000000005', updatedAt: '2026-09-22T10:00:00.000Z', about: 'capital', date: '2026-03-02', text: 'просадка' }],
    })
    expect(files.map((file) => file.path)).toContain('notes/2026-03.json')
  })

  it('особые периоды — одним файлом specials.json (Р-55)', () => {
    expect(config.places.specials).toEqual({ split: 'none', path: 'specials.json' })
    const files = layout.buildFiles({
      ...empty(),
      specials: [{ id: '01J000000000000000000007', updatedAt: '2026-10-03T10:00:00.000Z', from: '2026-07-10', to: '2026-07-20' }],
    })
    expect(files.map((file) => file.path)).toContain('specials.json')
  })

  it('трата события ложится в месяц своей даты, а не даты события', () => {
    const files = layout.buildFiles({
      ...empty(),
      roomSpends: [
        {
          id: '01J000000000000000000004',
          updatedAt: '2026-09-22T10:00:00.000Z',
          eventId: 'event-1',
          date: '2026-08-21',
          title: 'Падел',
          payerId: 'person-1',
          amount: 300000,
          split: [{ personId: 'person-1' }, { personId: 'person-2' }],
        },
      ],
    })
    expect(files.map((file) => file.path)).toContain('spends/2026-08.json')
  })

  it('запись без даты и без периода не теряется — уходит в undated', () => {
    const broken: Entry = {
      id: '01J000000000000000000003',
      updatedAt: '2026-09-20T10:00:00.000Z',
      kind: 'expense',
      accountId: 'account-1',
      money: { amount: 100, currency: 'RUB' },
    }
    expect(entryDate(broken)).toBeNull()
  })
})
