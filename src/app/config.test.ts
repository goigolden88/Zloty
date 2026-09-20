import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../shared/core/db.ts'
import { createLayout } from '../shared/core/layout.ts'
import { checkConfig, LOCAL_STORES } from '../shared/core/model.ts'
import { config } from './config.ts'
import { entryDate, SCHEMA_VERSION, SYNCED_STORES, V1_STORES, type Entry } from './model.ts'

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

  it('версия схемы 1, миграций нет: первая придёт с долгами в Этапе 3', () => {
    expect(config.schemaVersion).toBe(1)
    expect(SCHEMA_VERSION).toBe(1)
    expect(config.migrations).toEqual([])
  })

  it('восемь хранилищ, все — в раскладке версии 1', () => {
    expect([...config.stores]).toEqual([
      'profile',
      'currencies',
      'accounts',
      'categories',
      'recurring',
      'rates',
      'entries',
      'balances',
    ])
    expect([...config.v1Stores]).toEqual([...SYNCED_STORES])
    expect([...V1_STORES]).toEqual([...SYNCED_STORES])
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

  it('все восемь хранилищ заводятся в базе и принимают запись', async () => {
    for (const store of config.stores) {
      expect(await db.count(store)).toBe(0)
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

    const files = layout.buildFiles({
      profile: [],
      currencies: [],
      accounts: [],
      categories: [],
      recurring: [],
      rates: [],
      entries: [operation, total],
      balances: [],
    })
    const paths = files.map((file) => file.path)
    expect(paths).toContain('entries/2026-08.json')
    expect(paths).toContain('entries/2026-01.json')
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
