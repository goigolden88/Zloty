import { describe, expect, it } from 'vitest'
import type { Rate } from '../../app/model.ts'
import { convert, findRate, RATE_MAX_AGE_DAYS } from './rates.ts'

function rate(date: string, from: string, to: string, value: number): Rate {
  return {
    id: `rate-${from}-${to}-${date}`,
    updatedAt: '2026-09-20T10:00:00.000Z',
    date,
    from,
    to,
    rate: value,
    source: 'manual',
  }
}

// Курсы выдуманы: круглые числа, чтобы проверять арифметику, а не рынок.
const rates: Rate[] = [
  rate('2026-08-01', 'USD', 'RUB', 80),
  rate('2026-09-01', 'USD', 'RUB', 90),
  rate('2026-09-10', 'EUR', 'RUB', 100),
]

describe('какой курс берётся', () => {
  it('на дату события, когда курс на неё есть', () => {
    expect(findRate(rates, 'USD', 'RUB', '2026-09-01')).toEqual({
      rate: 90,
      date: '2026-09-01',
      exact: true,
      inverted: false,
    })
  })

  it('ближайший более ранний, когда на дату курса нет', () => {
    const found = findRate(rates, 'USD', 'RUB', '2026-09-05')
    expect(found).toEqual({ rate: 90, date: '2026-09-01', exact: false, inverted: false })
  })

  it('более поздний курс не берётся: операция стоила столько, сколько тогда', () => {
    const found = findRate(rates, 'USD', 'RUB', '2026-08-15')
    expect(found?.date).toBe('2026-08-01')
  })

  it('курс старше месяца не годится — позиция останется без курса', () => {
    expect(findRate(rates, 'EUR', 'RUB', '2026-12-31')).toBeNull()
    expect(findRate(rates, 'USD', 'RUB', '2026-09-01', 0)).toEqual({
      rate: 90,
      date: '2026-09-01',
      exact: true,
      inverted: false,
    })
  })

  it('запись в обратную сторону переворачивается — второй раз вносить не надо', () => {
    const found = findRate(rates, 'RUB', 'USD', '2026-09-01')
    expect(found).toEqual({ rate: 1 / 90, date: '2026-09-01', exact: true, inverted: true })
  })

  it('та же валюта — курс единица, без записей', () => {
    expect(findRate([], 'RUB', 'RUB', '2026-09-01')).toEqual({
      rate: 1,
      date: '2026-09-01',
      exact: true,
      inverted: false,
    })
  })

  it('курса нет вовсе — null, а не единица', () => {
    expect(findRate(rates, 'BTC', 'RUB', '2026-09-01')).toBeNull()
  })

  it('месяц — это тот самый срок, который видно в справке', () => {
    expect(RATE_MAX_AGE_DAYS).toBe(31)
  })
})

describe('пересчёт', () => {
  it('считает по курсу на дату и говорит, на какую', () => {
    // 180,00 USD по 90 = 16 200,00 ₽.
    const result = convert({ amount: 18000, currency: 'USD' }, 'RUB', 2, 2, rates, '2026-09-01')
    expect(result).toEqual({
      money: { amount: 1620000, currency: 'RUB' },
      basis: { rate: 90, date: '2026-09-01', exact: true, inverted: false },
    })
  })

  it('разные знаки валют: сатоши в рубли', () => {
    const btcRates = [rate('2026-09-01', 'BTC', 'RUB', 5000000)]
    // 0,001 BTC (100 000 сатоши) по 5 000 000 ₽ за BTC = 5 000,00 ₽.
    const result = convert({ amount: 100000, currency: 'BTC' }, 'RUB', 2, 8, btcRates, '2026-09-01')
    expect(result).toEqual({
      money: { amount: 500000, currency: 'RUB' },
      basis: { rate: 5000000, date: '2026-09-01', exact: true, inverted: false },
    })
  })

  it('нет курса — не ноль и не тишина, а названная нехватка', () => {
    const result = convert({ amount: 100, currency: 'BTC' }, 'RUB', 2, 8, rates, '2026-09-01')
    expect(result).toEqual({ missing: { from: 'BTC', to: 'RUB', date: '2026-09-01' } })
  })

  it('курс на более раннюю дату виден в основании: exact = false', () => {
    const result = convert({ amount: 10000, currency: 'USD' }, 'RUB', 2, 2, rates, '2026-09-05')
    expect(result).toMatchObject({ basis: { date: '2026-09-01', exact: false } })
  })
})
