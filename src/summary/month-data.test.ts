import { describe, expect, it } from 'vitest'
import type { Currency, Entry, SpecialPeriod } from '../app/model.ts'
import type { DebtsData } from '../modules/debts/summary.ts'
import { monthReport, observations, usualMonth } from '../modules/ledger/month.ts'
import { monthData } from './month-data.ts'

/** Суммы, даты и названия выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'
const RUB: Currency = { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }

const NO_DEBTS: DebtsData = {
  people: [],
  rooms: [],
  roomEvents: [],
  roomSpends: [],
  roomTransfers: [],
  loans: [],
  repayments: [],
}

const TRIP: SpecialPeriod = { id: 'p-trip', updatedAt: AT, from: '2026-09-10', to: '2026-09-14', title: 'Поездка к морю' }

let seq = 0
function spend(date: string, amount: number): Entry {
  return { id: `e-${++seq}`, updatedAt: AT, kind: 'expense', accountId: 'acc', money: { amount, currency: 'RUB' }, date }
}

function screen(entries: Entry[], specials: SpecialPeriod[]) {
  return monthData({ entries, currencies: [RUB], rates: [], base: 'RUB', debts: NO_DEBTS, specials })
}

describe('данные «Месяца» с особыми периодами (Р-55)', () => {
  const list = [spend('2026-09-03', 200000), spend('2026-09-12', 700000)]

  it('трата с датой в периоде уходит из обычного расхода экрана', () => {
    const report = monthReport(screen(list, [TRIP]), '2026-09')
    expect(report.usualExpense.amount).toBe(200000)
    expect(report.specialExpense.amount).toBe(700000)
    expect(report.specialExpense.entries).toBe(1)
  })

  it('удалённый период экран в расчёт не кладёт', () => {
    const data = screen(list, [{ ...TRIP, deleted: true }])
    expect(data.specials).toEqual([])
    expect(monthReport(data, '2026-09').usualExpense.amount).toBe(900000)
  })

  it('обычный месяц экрана не видит трат периода', () => {
    const past = [spend('2026-08-05', 300000), spend('2026-08-12', 900000)]
    const august: SpecialPeriod = { id: 'p-aug', updatedAt: AT, from: '2026-08-10', to: '2026-08-20' }
    const seen = observations(screen(past, [august]), '2026-09')
    expect(usualMonth(seen.list, seen.missing)?.monthly).toBe(300000)
  })
})
