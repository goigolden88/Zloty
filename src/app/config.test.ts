import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../shared/core/db.ts'
import { createLayout } from '../shared/core/layout.ts'
import { checkConfig, LOCAL_STORES } from '../shared/core/model.ts'
import { config } from './config.ts'
import {
  DEBT_STORES,
  entryDate,
  SCHEMA_VERSION,
  SYNCED_STORES,
  V1_STORES,
  type Entry,
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

  it('долги дописаны к хранилищам, а не в раскладку версии 1', () => {
    expect([...config.stores]).toEqual([...V1_STORES, ...DEBT_STORES])
    expect([...config.stores]).toHaveLength(15)
    for (const store of DEBT_STORES) {
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

describe('миграция на версию 2 — долги (Р-30)', () => {
  it('версия схемы 2, шаг один и только добавляет', () => {
    expect(config.schemaVersion).toBe(2)
    expect(SCHEMA_VERSION).toBe(2)
    expect(config.migrations).toHaveLength(1)
    const [step] = config.migrations
    expect(step?.to).toBe(2)
    expect(step?.additive).toBe(true)
  })

  it('свежая база доезжает до версии 2: все пятнадцать хранилищ есть и принимают запись', async () => {
    for (const store of config.stores) {
      expect(await db.count(store)).toBe(0)
    }
  })

  it('база версии 1 с записями открывается версией 2: учёт цел, хранилища долгов пусты', async () => {
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
    for (const store of DEBT_STORES) {
      expect(await db.count(store)).toBe(0)
    }
  })

  it('слепок, выгруженный на версии 1, приложение принимает: шаг только добавляет', () => {
    expect(() => db.checkSnapshotVersion(1)).not.toThrow()
    expect(() => db.checkSnapshotVersion(2)).not.toThrow()
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

  it('долгам индексов не заводили: читать по ним ядро всё равно не умеет', () => {
    for (const store of DEBT_STORES) {
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
