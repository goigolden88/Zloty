import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SYNCED_STORES } from './app/model.ts'
import { fetchRates, RATE_SOURCE } from './modules/money/currency-api.ts'
import { importPrompt, planImport, type Data } from './registry.ts'

/** Всё выдумано: счета, суммы, заметки (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-23T10:00:00.000Z'

function empty(): Data {
  const data = {} as Record<string, unknown[]>
  for (const store of SYNCED_STORES) data[store] = []
  return data as unknown as Data
}

let ids = 0
const ctx = { newId: () => `id-${++ids}`, now: AT }

const file = JSON.stringify({
  format: 'zloty-import',
  version: 1,
  currencies: [
    { code: 'RUB', name: 'Рубль', decimals: 2 },
    { code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 } },
  ],
  accounts: [
    { name: 'Банк', currency: 'RUB', kind: 'savings' },
    { name: 'Кошелёк', currency: 'BTC', kind: 'savings' },
  ],
  rates: [{ date: '2026-09-01', from: 'BTC', to: 'USD', rate: 60000 }],
  balances: [
    { account: 'Банк', date: '2026-09-01', part: 'на счёте', amount: 1000 },
    { account: 'Банк', date: '2026-09-01', part: 'кредитка', amount: 400, deferred: true },
    { account: 'Кошелёк', date: '2026-09-01', amount: 0.0125 },
  ],
  notes: [{ date: '2026-09-01', text: 'рынок просел' }],
})

describe('файл переноса капитала целиком — одним импортом', () => {
  it('валюты, счета, курсы, снимки и заметки: каждый раздел видит заведённое выше', () => {
    const plan = planImport(file, empty(), ctx)
    expect(plan.issues).toEqual([])
    expect(plan.writes.currencies).toHaveLength(2)
    expect(plan.writes.accounts).toHaveLength(2)
    expect(plan.writes.rates).toHaveLength(1)
    expect(plan.writes.balances).toHaveLength(3)
    expect(plan.writes.notes).toHaveLength(1)
  })

  it('снимок ложится на счёт, заведённый этим же файлом', () => {
    const plan = planImport(file, empty(), ctx)
    const wallet = plan.writes.accounts?.find((each) => each.name === 'Кошелёк')
    const snapshot = plan.writes.balances?.find((each) => each.accountId === wallet?.id)
    expect(snapshot?.amount).toBe(1250000)
  })

  it('сводка называет снимки и заметки своими словами', () => {
    const plan = planImport(file, empty(), ctx)
    const forms = plan.added.map((each) => each.forms[0])
    expect(forms).toContain('снимок')
    expect(forms).toContain('заметка')
  })
})

describe('промпт', () => {
  it('знает разделы капитала', () => {
    const prompt = importPrompt(empty(), '2026-09-23')
    expect(prompt).toContain('"balances"')
    expect(prompt).toContain('"notes"')
    expect(prompt).toContain('"deferred"')
  })
})

describe('курсы из публичного источника (Р-38)', () => {
  it('ответ источника становится файлом, который проходит тот же импорт, и помнит источник', async () => {
    const sample = { date: '2026-09-01', rub: { usd: 0.0115849, btc: 0.000000147 } }
    const fetcher = async () => ({ ok: true, status: 200, json: async () => sample })
    const result = await fetchRates(['2026-09-01'], 'RUB', ['USD', 'BTC'], fetcher)
    const plan = planImport(result.file, empty(), ctx)
    expect(plan.issues).toEqual([])
    expect(plan.writes.rates?.map((each) => each.source)).toEqual([RATE_SOURCE, RATE_SOURCE])
  })
})

describe('исходы импорта своими словами (Я-07 ядра)', () => {
  const rub = { id: 'rub', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }
  const bank = { id: 'bank', updatedAt: AT, name: 'Банк', currency: 'RUB', kind: 'savings' as const, order: 0 }
  const food = { id: 'food', updatedAt: AT, name: 'Еда', side: 'expense' as const, order: 0 }
  const total = {
    id: 'total',
    updatedAt: AT,
    kind: 'expense' as const,
    accountId: 'bank',
    money: { amount: 100000, currency: 'RUB' },
    period: { from: '2026-09-01', to: '2026-09-30' },
  }

  function base(): Data {
    const data = empty()
    data.currencies = [rub]
    data.accounts = [bank]
    data.categories = [food]
    data.entries = [total]
    return data
  }

  /** Выписка «Банка» за сентябрь: две траты, сверка сходится, одна сумма с лишним знаком. */
  const statement = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: 'zloty-import',
      version: 1,
      entries: [
        { kind: 'expense', account: 'Банк', amount: 600.004, date: '2026-09-10', category: 'Еда', bankText: 'ОДНА' },
        { kind: 'expense', account: 'Банк', amount: 500, date: '2026-09-20', category: 'Еда', bankText: 'ДВЕ' },
      ],
      checks: [{ account: 'Банк', from: '2026-09-01', to: '2026-09-30', opening: 2000, closing: 900 }],
      ...extra,
    })

  it('округление и замена итога — заметки: в отказы не попадают', () => {
    const plan = planImport(statement(), base(), ctx)
    expect(plan.issues).toEqual([])
    expect(plan.notes?.map((each) => each.title).sort()).toEqual(['итог периода', 'округление'])
  })

  it('«Удалится» сходится с надгробиями в записях', () => {
    const plan = planImport(statement(), base(), ctx)
    const tombstones = (plan.writes.entries ?? []).filter((each) => each.deleted)
    expect(tombstones.map((each) => each.id)).toEqual(['total'])
    expect(plan.removed).toEqual([{ count: 1, forms: ['итог периода', 'итога периода', 'итогов периода'] }])
  })

  it('отметка сверки на счёте из базы — «Изменится», и он же лежит в записях', () => {
    const plan = planImport(statement(), base(), ctx)
    expect(plan.writes.accounts?.map((each) => [each.id, each.loadedThrough])).toEqual([['bank', '2026-09-30']])
    expect(plan.changed).toEqual([{ count: 1, forms: ['счёт', 'счёта', 'счетов'] }])
    expect(plan.added.some((each) => each.forms[0] === 'счёт')).toBe(false)
  })

  it('счёт, заведённый этим же файлом, — новый, а не правка', () => {
    const data = base()
    data.accounts = []
    data.entries = []
    const plan = planImport(statement({ accounts: [{ name: 'Банк', currency: 'RUB', kind: 'savings' }] }), data, ctx)
    expect(plan.writes.accounts).toHaveLength(1)
    expect(plan.writes.accounts?.[0]?.loadedThrough).toBe('2026-09-30')
    expect(plan.added.find((each) => each.forms[0] === 'счёт')?.count).toBe(1)
    expect(plan.changed ?? []).toEqual([])
  })

  it('та же выписка второй раз ничего не меняет и не удаляет', () => {
    const first = planImport(statement(), base(), ctx)
    const data = base()
    data.accounts = first.writes.accounts ?? []
    data.entries = first.writes.entries ?? []
    const again = planImport(statement(), data, ctx)
    expect(again.changed ?? []).toEqual([])
    expect(again.removed ?? []).toEqual([])
    expect(again.skipped).toBe(2)
  })
})
