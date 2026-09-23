import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SYNCED_STORES } from './app/model.ts'
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
