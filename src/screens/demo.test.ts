import { describe, expect, it } from 'vitest'
import { config } from '../app/config.ts'
import { SYNCED_STORES } from '../app/model.ts'
import { checkDemo } from '../shared/core/demo.ts'
import { addMonths, monthOf } from '../shared/core/dates.ts'
import { capitalOn } from '../modules/capital/capital.ts'
import { loanState } from '../modules/debts/loans.ts'
import { monthReport } from '../modules/ledger/month.ts'
import { monthData } from '../summary/month-data.ts'
import { demo } from './demo.ts'

/**
 * Демо-данные (Я-44, Я-45 «FamilyCore»). Сторож ядра `checkDemo`: каждое
 * хранилище получает записи, у записей — поля `Base`, id не повторяются.
 * Новое хранилище без строки в `demo.ts` — красный тест здесь.
 *
 * Сверх сторожа — правила модели, которые держит и демо, и то, что экраны
 * на нём отвечают числом, а не «не внесён» и «нет курса».
 */

const DAY = '2026-10-12'

describe('демо «Злотых»', () => {
  it('полное: записи каждому хранилищу, без изъянов', () => {
    expect(checkDemo(config, DAY)).toEqual([])
  })

  it('в конфиге — та же функция', () => {
    expect(config.demo).toBe(demo)
  })

  it('ни одной записи позже дня входа; учёт — с первого числа три месяца назад', () => {
    const data = demo(DAY)
    expect(data.entries.every((entry) => entry.date !== undefined && entry.date <= DAY)).toBe(true)
    expect(data.balances.every((balance) => balance.date <= DAY)).toBe(true)
    const first = data.entries.map((entry) => entry.date ?? '').sort()[0]
    expect(first).toBe(`${addMonths(monthOf(DAY), -3)}-01`)
  })

  it('суммы — целые, положительные, с кодом валюты из справочника (Р-04)', () => {
    const data = demo(DAY)
    const codes = new Set(data.currencies.map((each) => each.code))
    const moneys = [
      ...data.entries.map((entry) => entry.money),
      ...data.loans.map((loan) => loan.money),
      ...data.repayments.map((repayment) => repayment.money),
      ...data.recurring.map((each) => each.expected),
    ]
    for (const money of moneys) {
      expect(Number.isInteger(money.amount) && money.amount > 0).toBe(true)
      expect(codes.has(money.currency)).toBe(true)
    }
    for (const amount of [...data.roomSpends.map((each) => each.amount), ...data.roomTransfers.map((each) => each.amount)]) {
      expect(Number.isInteger(amount)).toBe(true)
    }
  })

  it('настройки учёта — одна запись, «я» — один человек', () => {
    const data = demo(DAY)
    expect(data.profile).toHaveLength(1)
    expect(data.people.filter((person) => person.self)).toHaveLength(1)
  })

  it('ссылки — на записи того же демо', () => {
    const data = demo(DAY)
    const ids = (list: readonly { id: string }[]) => new Set(list.map((each) => each.id))
    const accounts = ids(data.accounts)
    const categories = ids(data.categories)
    const people = ids(data.people)
    const events = ids(data.roomEvents)
    for (const entry of data.entries) {
      expect(accounts.has(entry.accountId)).toBe(true)
      if (entry.toAccountId) expect(accounts.has(entry.toAccountId)).toBe(true)
      if (entry.categoryId) expect(categories.has(entry.categoryId)).toBe(true)
      if (entry.recurringId) expect(ids(data.recurring).has(entry.recurringId)).toBe(true)
    }
    for (const balance of data.balances) expect(accounts.has(balance.accountId)).toBe(true)
    for (const repayment of data.repayments) expect(ids(data.loans).has(repayment.loanId)).toBe(true)
    for (const spend of data.roomSpends) {
      expect(events.has(spend.eventId)).toBe(true)
      expect(people.has(spend.payerId)).toBe(true)
    }
    for (const transfer of data.roomTransfers) {
      expect(ids(data.rooms).has(transfer.roomId)).toBe(true)
      expect(people.has(transfer.fromId) && people.has(transfer.toId)).toBe(true)
    }
  })

  it('«Месяц» дня входа считает отложенное: доход внесён, курса хватает', () => {
    const data = demo(DAY)
    const report = monthReport(
      monthData({
        entries: data.entries,
        currencies: data.currencies,
        rates: data.rates,
        base: 'RUB',
        debts: data,
        specials: data.specials,
      }),
      monthOf(DAY),
      DAY,
      null,
    )
    expect(report.savedProblem).toBeNull()
    expect(report.income.entries).toBeGreaterThan(0)
    expect(report.savingsRate).not.toBeNull()
    expect([...report.income.missing, ...report.expense.missing]).toEqual([])
  })

  it('«Капитал» на каждый снимок — без позиций без курса и без счетов без снимка', () => {
    const data = demo(DAY)
    for (const date of new Set(data.balances.map((balance) => balance.date))) {
      const capital = capitalOn({ ...data, base: 'RUB' }, date)
      expect(capital.missing).toEqual([])
      expect(capital.without).toEqual([])
    }
  })

  it('разовый долг возвращён частью', () => {
    const data = demo(DAY)
    const loan = data.loans[0]
    if (!loan) throw new Error('в демо нет долга')
    const { left } = loanState(loan, data.repayments)
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(loan.money.amount)
  })

  it('другой день — другие даты: демо не стареет, в том числе первого числа', () => {
    for (const later of ['2026-12-01', '2027-03-31']) {
      expect(checkDemo(config, later)).toEqual([])
      expect(demo(later).balances.some((balance) => balance.date === later)).toBe(true)
    }
    expect(Object.keys(demo(DAY)).sort()).toEqual([...SYNCED_STORES].sort())
  })
})
