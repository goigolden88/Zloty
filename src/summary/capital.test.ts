import { describe, expect, it } from 'vitest'
import type { Account, Balance, Currency, Loan, Person, Rate } from '../app/model.ts'
import type { DebtsData } from '../modules/debts/summary.ts'
import { capitalSeries, fullCapitalOn, type FullData } from './capital.ts'

/** Люди, счета и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const currencies: Currency[] = [
  { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 },
  { id: 'c2', updatedAt: AT, code: 'USD', name: 'Доллар', decimals: 2, order: 1 },
]

const bank: Account = { id: 'bank', updatedAt: AT, name: 'Банк', currency: 'RUB', kind: 'savings', order: 0 }

const balances: Balance[] = [
  { id: 'b1', updatedAt: AT, accountId: 'bank', date: '2026-08-01', amount: 9000000 },
  { id: 'b2', updatedAt: AT, accountId: 'bank', date: '2026-09-01', amount: 9900000 },
]

const rates: Rate[] = [
  { id: 'r1', updatedAt: AT, date: '2026-08-01', from: 'USD', to: 'RUB', rate: 90, source: 'import' },
  { id: 'r2', updatedAt: AT, date: '2026-09-01', from: 'USD', to: 'RUB', rate: 99, source: 'import' },
]

const people: Person[] = [
  { id: 'me', updatedAt: AT, name: 'Я', self: true },
  { id: 'petya', updatedAt: AT, name: 'Петя' },
  { id: 'masha', updatedAt: AT, name: 'Маша' },
]

const loans: Loan[] = [
  // Дал Пете 1 000 ₽ 15 августа, взял у Маши 10 $ 20 августа.
  { id: 'l1', updatedAt: AT, personId: 'petya', direction: 'lent', money: { amount: 100000, currency: 'RUB' }, date: '2026-08-15' },
  { id: 'l2', updatedAt: AT, personId: 'masha', direction: 'borrowed', money: { amount: 1000, currency: 'USD' }, date: '2026-08-20' },
]

const debts: DebtsData = { people, rooms: [], roomEvents: [], roomSpends: [], roomTransfers: [], loans, repayments: [] }

const data: FullData = { accounts: [bank], balances, rates, currencies, base: 'RUB', debts, show: 'USD' }

describe('капитал с долгами', () => {
  it('мне должны прибавляется, я должен вычитается — долги на ту же дату', () => {
    const capital = fullCapitalOn(data, '2026-09-01')
    expect(capital.owedToMe).toBe(100000)
    // 10 $ по 99 = 990 ₽.
    expect(capital.owedByMe).toBe(99000)
    expect(capital.net).toBe(9900000 + 100000 - 99000)
  })

  it('долг, заведённый позже даты, в капитал этой даты не входит', () => {
    const capital = fullCapitalOn(data, '2026-08-01')
    expect(capital.owedToMe).toBe(0)
    expect(capital.owedByMe).toBe(0)
    expect(capital.net).toBe(9000000)
  })

  it('итог во второй валюте — по курсу на дату капитала', () => {
    const capital = fullCapitalOn(data, '2026-09-01')
    // 99 010 ₽ по 99 = 1 000,10 $.
    expect(capital.shown).toMatchObject({ amount: 100010, currency: 'USD' })
  })

  it('курса для второй валюты нет — её итога нет, а не ноль', () => {
    expect(fullCapitalOn({ ...data, rates: [] }, '2026-08-01').shown).toBeNull()
  })

  it('долг без курса не пропадает молча — назван', () => {
    const capital = fullCapitalOn({ ...data, rates: [] }, '2026-09-01')
    expect(capital.missing).toEqual([{ currency: 'USD', date: '2026-09-01', count: 1 }])
  })
})

describe('точки капитала', () => {
  it('по датам снимков, с «% к прошлому»', () => {
    const series = capitalSeries(data)
    expect(series.map((each) => each.date)).toEqual(['2026-08-01', '2026-09-01'])
    expect(series[0]?.change).toBeNull()
    expect(series[1]?.change).toBeCloseTo((9901000 - 9000000) / 9000000, 10)
  })
})
