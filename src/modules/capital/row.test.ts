import { describe, expect, it } from 'vitest'
import type { Account, Balance, Currency } from '../../app/model.ts'
import { DEFERRED_PART, draftRow, MAIN_PART, rowWrites, unchanged, withDeferred, type RowDraft } from './row.ts'

/** Счета и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const currencies: Currency[] = [
  { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 },
  { id: 'c2', updatedAt: AT, code: 'USD', name: 'Доллар', decimals: 2, order: 1 },
  { id: 'c3', updatedAt: AT, code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 }, order: 2 },
]

function account(id: string, order: number, fields: Partial<Account> = {}): Account {
  return { id, updatedAt: AT, name: id, currency: 'RUB', kind: 'savings', order, ...fields }
}

const accounts: Account[] = [
  account('bank', 0),
  account('cash', 1, { currency: 'USD' }),
  account('wallet', 2, { currency: 'BTC' }),
  account('new', 3),
  account('old', 4, { archived: true }),
  account('history', 5, { ledgerOnly: true }),
]

let seq = 0
function balance(accountId: string, date: string, amount: number, part?: string): Balance {
  const made: Balance = { id: `b-${++seq}`, updatedAt: AT, accountId, date, amount }
  if (part !== undefined) made.part = part
  return made
}

const balances: Balance[] = [
  balance('bank', '2026-08-01', 1000000, 'на счёте'),
  balance('bank', '2026-08-01', -300000, 'кредитка'),
  balance('cash', '2026-08-01', 15000),
  balance('wallet', '2026-08-01', 1250000), // 12,5 mBTC
]

let ids = 0
const ctx = { newId: () => `new-${++ids}`, now: '2026-09-23T10:00:00.000Z' }
const data = { accounts, balances, currencies }

function row(id: string, rows: RowDraft[]): RowDraft {
  const found = rows.find((each) => each.accountId === id)
  if (!found) throw new Error(`нет строки ${id}`)
  return found
}

describe('черновик строки (Р-39)', () => {
  const rows = draftRow(accounts, balances, currencies, '2026-09-23')

  it('все живые счета капитала — кроме архивных и счёта истории', () => {
    expect(rows.map((each) => each.accountId)).toEqual(['bank', 'cash', 'wallet', 'new'])
  })

  it('поля заполнены прошлыми значениями в единице показа', () => {
    expect(row('cash', rows).parts).toEqual([{ part: '', value: '150', was: '150', deferred: false }])
    expect(row('wallet', rows).parts[0]?.value).toBe('12,5')
  })

  it('части сохраняются, а отложенный платёж стоит суммой к возврату, без минуса', () => {
    expect(row('bank', rows).parts).toEqual([
      { part: 'на счёте', value: '10000', was: '10000', deferred: false },
      { part: 'кредитка', value: '3000', was: '3000', deferred: true },
    ])
  })

  it('счёт без снимков — пустое поле, а не ноль', () => {
    expect(row('new', rows).parts).toEqual([{ part: '', value: '', was: '', deferred: false }])
  })

  it('нетронутая строка видна как прежняя; пустая — нет', () => {
    expect(unchanged(row('cash', rows))).toBe(true)
    expect(unchanged(row('new', rows))).toBe(false)
    const touched = { ...row('cash', rows), parts: [{ part: '', value: '160', was: '150', deferred: false }] }
    expect(unchanged(touched)).toBe(false)
  })

  it('отложенный платёж добавляется частью, а основная сумма получает имя', () => {
    const added = withDeferred(row('cash', rows))
    expect(added.parts.map((each) => [each.part, each.deferred])).toEqual([
      [MAIN_PART, false],
      [DEFERRED_PART, true],
    ])
  })
})

describe('запись строки', () => {
  const rows = draftRow(accounts, balances, currencies, '2026-09-23')

  it('пишет заполненные счета на одну дату; пустой — пропуск, а не ноль', () => {
    const result = rowWrites(rows, data, '2026-09-23', ctx)
    expect(result.problems).toEqual([])
    expect(new Set(result.put.map((each) => each.date))).toEqual(new Set(['2026-09-23']))
    expect(result.put.map((each) => each.accountId)).not.toContain('new')
  })

  it('отложенный платёж записан со знаком минус (Р-35)', () => {
    const result = rowWrites(rows, data, '2026-09-23', ctx)
    const card = result.put.find((each) => each.part === 'кредитка')
    expect(card?.amount).toBe(-300000)
  })

  it('mBTC — ровно в сатоши, без потери знаков', () => {
    const wallet = { accountId: 'wallet', parts: [{ part: '', value: '21,63', was: '', deferred: false }] }
    const result = rowWrites([wallet], data, '2026-09-23', ctx)
    expect(result.put).toMatchObject([{ accountId: 'wallet', amount: 2163000 }])
    expect(result.put[0]?.part).toBeUndefined()
  })

  it('снимок на ту же дату правится: прежние записи уходят в надгробия, а не складываются', () => {
    const first = rowWrites(rows, data, '2026-09-23', ctx)
    const again = rowWrites(rows, { ...data, balances: [...balances, ...first.put] }, '2026-09-23', ctx)
    expect(again.removed.map((each) => each.id).sort()).toEqual(first.put.map((each) => each.id).sort())
    expect(again.removed.every((each) => each.deleted)).toBe(true)
  })

  it('несколько сумм без имён — отказ, и не пишется ничего', () => {
    const bad = { accountId: 'bank', parts: [
      { part: '', value: '100', was: '', deferred: false },
      { part: '', value: '200', was: '', deferred: false },
    ] }
    const result = rowWrites([...rows, bad], data, '2026-09-23', ctx)
    expect(result.put).toEqual([])
    expect(result.problems).toEqual([{ accountId: 'bank', reason: 'у счёта несколько сумм — назовите каждую часть' }])
  })

  it('не сумма и сумма со знаком — отказ с тем, что вписано', () => {
    for (const value of ['сто', '-100']) {
      const bad = { accountId: 'cash', parts: [{ part: '', value, was: '', deferred: false }] }
      expect(rowWrites([bad], data, '2026-09-23', ctx).problems).toEqual([{ accountId: 'cash', reason: `«${value}» — не сумма` }])
    }
  })

  it('дата не ГГГГ-ММ-ДД — отказ', () => {
    expect(rowWrites(rows, data, '23.09.2026', ctx).problems[0]?.reason).toContain('ГГГГ-ММ-ДД')
  })
})
