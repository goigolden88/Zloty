import { describe, expect, it } from 'vitest'
import type { Account, Balance, Currency, Rate } from '../../app/model.ts'
import { capitalDates, capitalOn, changeOf, staleOf, type CapitalData } from './capital.ts'

/** Счета, суммы и курсы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const currencies: Currency[] = [
  { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 },
  { id: 'c2', updatedAt: AT, code: 'USD', name: 'Доллар', decimals: 2, order: 1 },
  { id: 'c3', updatedAt: AT, code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 }, order: 2 },
]

function account(id: string, fields: Partial<Account> = {}): Account {
  return { id, updatedAt: AT, name: id, currency: 'RUB', kind: 'savings', order: 0, ...fields }
}

const BANK = account('bank')
const CASH = account('cash', { currency: 'USD' })
const WALLET = account('wallet', { currency: 'BTC' })
const PLATFORM = account('platform', { currency: 'USD', kind: 'investment' })
const HISTORY = account('history', { ledgerOnly: true })

let seq = 0
function balance(accountId: string, date: string, amount: number, fields: Partial<Balance> = {}): Balance {
  return { id: `b-${++seq}`, updatedAt: AT, accountId, date, amount, ...fields }
}

function rate(date: string, from: string, to: string, value: number): Rate {
  return { id: `r-${from}-${to}-${date}`, updatedAt: AT, date, from, to, rate: value, source: 'import' }
}

const rates: Rate[] = [
  rate('2026-09-01', 'USD', 'RUB', 90),
  rate('2026-09-01', 'BTC', 'USD', 50000),
]

function data(balances: Balance[], accounts: Account[] = [BANK, CASH, WALLET, PLATFORM, HISTORY]): CapitalData {
  return { accounts, balances, rates, currencies, base: 'RUB' }
}

describe('капитал на дату (Р-39)', () => {
  const row = [
    // Банк по частям: на счёте 12 000 ₽, кредитка — 5 000 ₽ к возврату (Р-35).
    balance('bank', '2026-09-01', 1200000, { part: 'на счёте' }),
    balance('bank', '2026-09-01', -500000, { part: 'кредитка' }),
    balance('cash', '2026-09-01', 10000), // 100 $
    balance('wallet', '2026-09-01', 1000000), // 0,01 BTC = 10 mBTC
    balance('platform', '2026-09-01', 5000), // 50 $
  ]

  it('сбережения — деньги как лежат, кредитка внутри них не вычтена', () => {
    const capital = capitalOn(data(row), '2026-09-01')
    // 12 000 + 100 $ × 90 + 0,01 BTC × 50 000 $ × 90 = 12 000 + 9 000 + 45 000.
    expect(capital.savings).toBe(6600000)
    expect(capital.investments).toBe(450000)
  })

  it('отложенный платёж — своей строкой и вычитается из итога', () => {
    const capital = capitalOn(data(row), '2026-09-01')
    expect(capital.deferred).toBe(500000)
    expect(capital.total).toBe(6600000 + 450000 - 500000)
  })

  it('биткойн пересчитан через доллар, и оба курса названы', () => {
    const wallet = capitalOn(data(row), '2026-09-01').holdings.find((each) => each.account.id === 'wallet')
    expect(wallet?.heldBase).toBe(4500000)
    expect(wallet?.legs.map((leg) => `${leg.from}→${leg.to}`)).toEqual(['BTC→USD', 'USD→RUB'])
  })

  it('счёт истории в капитал не входит: денег на нём нет', () => {
    const withHistory = [...row, balance('history', '2026-09-01', 99999900)]
    const capital = capitalOn(data(withHistory), '2026-09-01')
    expect(capital.holdings.map((each) => each.account.id)).not.toContain('history')
    expect(capital.without.map((each) => each.id)).not.toContain('history')
  })

  it('снимок старше даты входит в итог и называется своей датой', () => {
    const later = [...row, balance('bank', '2026-09-10', 1300000)]
    const capital = capitalOn(data(later), '2026-09-10')
    expect(staleOf(capital).map((each) => [each.account.id, each.date])).toEqual([
      ['cash', '2026-09-01'],
      ['wallet', '2026-09-01'],
      ['platform', '2026-09-01'],
    ])
    expect(capital.holdings.find((each) => each.account.id === 'bank')?.held).toBe(1300000)
  })

  it('снимок из будущего не берётся', () => {
    const later = [...row, balance('bank', '2026-09-10', 1300000)]
    const bank = capitalOn(data(later), '2026-09-05').holdings.find((each) => each.account.id === 'bank')
    expect(bank?.date).toBe('2026-09-01')
  })

  it('счёт без снимка назван, а не молча пропущен', () => {
    const noWallet = row.filter((each) => each.accountId !== 'wallet')
    expect(capitalOn(data(noWallet), '2026-09-01').without.map((each) => each.id)).toEqual(['wallet'])
  })

  it('архивный счёт без снимков «без снимка» не называется', () => {
    const noWallet = row.filter((each) => each.accountId !== 'wallet')
    const archived = [BANK, CASH, { ...WALLET, archived: true }, PLATFORM, HISTORY]
    expect(capitalOn(data(noWallet, archived), '2026-09-01').without).toEqual([])
  })

  it('нет курса — позиция вне итога и названа с числом', () => {
    const capital = capitalOn({ ...data(row), rates: [] }, '2026-09-01')
    expect(capital.savings).toBe(1200000)
    expect(capital.missing).toEqual([
      { currency: 'USD', date: '2026-09-01', count: 2 },
      { currency: 'BTC', date: '2026-09-01', count: 1 },
    ])
  })

  it('надгробие снимка не считается', () => {
    const gone = [...row, balance('cash', '2026-09-01', 500000, { deleted: true })]
    expect(capitalOn(data(gone), '2026-09-01').savings).toBe(6600000)
  })

  it('снимок без части рядом с частями той же даты — берутся части, и это видно', () => {
    const both = [...row, balance('bank', '2026-09-01', 7000000)]
    const bank = capitalOn(data(both), '2026-09-01').holdings.find((each) => each.account.id === 'bank')
    expect(bank?.held).toBe(1200000)
    expect(bank?.mixed).toBe(true)
  })
})

describe('точки капитала', () => {
  it('даты, на которые внесён хоть один снимок, — без счетов истории и надгробий', () => {
    const list = [
      balance('bank', '2026-09-10', 1),
      balance('cash', '2026-09-01', 1),
      balance('bank', '2026-09-01', 1),
      balance('history', '2026-08-01', 1),
      balance('wallet', '2026-07-01', 1, { deleted: true }),
    ]
    expect(capitalDates(data(list))).toEqual(['2026-09-01', '2026-09-10'])
  })

  it('«% к прошлому»: доля роста; прошлого нет или он не больше нуля — доли нет', () => {
    expect(changeOf(110, 100)).toBeCloseTo(0.1, 10)
    expect(changeOf(90, 100)).toBeCloseTo(-0.1, 10)
    expect(changeOf(100, null)).toBeNull()
    expect(changeOf(100, 0)).toBeNull()
    expect(changeOf(100, -50)).toBeNull()
  })
})

describe('модуль капитала не знает про учёт и долги', () => {
  // Модули друг про друга не знают (CLAUDE.md); сводит их `src/summary/`.
  const files = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true })

  it('ни один файл модуля не импортирует ledger и debts', () => {
    const sources = Object.entries(files).filter(([path]) => !path.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(0)
    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(/from '\.\.\/(ledger|debts)\//)
    }
  })
})
