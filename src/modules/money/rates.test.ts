import { describe, expect, it } from 'vitest'
import type { Rate } from '../../app/model.ts'
import { convert, findPath, findRate, RATE_MAX_AGE_DAYS } from './rates.ts'

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
      legs: [{ rate: 90, date: '2026-09-01', exact: true, inverted: false, from: 'USD', to: 'RUB' }],
    })
  })

  it('разные знаки валют: сатоши в рубли', () => {
    const btcRates = [rate('2026-09-01', 'BTC', 'RUB', 5000000)]
    // 0,001 BTC (100 000 сатоши) по 5 000 000 ₽ за BTC = 5 000,00 ₽.
    const result = convert({ amount: 100000, currency: 'BTC' }, 'RUB', 2, 8, btcRates, '2026-09-01')
    expect(result).toEqual({
      money: { amount: 500000, currency: 'RUB' },
      legs: [{ rate: 5000000, date: '2026-09-01', exact: true, inverted: false, from: 'BTC', to: 'RUB' }],
    })
  })

  it('нет курса — не ноль и не тишина, а названная нехватка', () => {
    const result = convert({ amount: 100, currency: 'BTC' }, 'RUB', 2, 8, rates, '2026-09-01')
    expect(result).toEqual({ missing: { from: 'BTC', to: 'RUB', date: '2026-09-01' } })
  })

  it('курс на более раннюю дату виден в основании: exact = false', () => {
    const result = convert({ amount: 10000, currency: 'USD' }, 'RUB', 2, 2, rates, '2026-09-05')
    expect(result).toMatchObject({ legs: [{ date: '2026-09-01', exact: false }] })
  })
})

describe('через промежуточную валюту (Р-37)', () => {
  // Как у человека: биткойн и евро — к доллару, доллар — к рублю.
  const paired: Rate[] = [
    rate('2026-09-01', 'USD', 'RUB', 90),
    rate('2026-09-01', 'BTC', 'USD', 60000),
    rate('2026-09-01', 'EUR', 'USD', 1.2),
  ]

  it('прямого курса нет — путь через доллар, и оба плеча названы', () => {
    const path = findPath(paired, 'BTC', 'RUB', '2026-09-01')
    expect(path?.rate).toBe(5400000)
    expect(path?.legs.map((leg) => [leg.from, leg.to, leg.rate])).toEqual([
      ['BTC', 'USD', 60000],
      ['USD', 'RUB', 90],
    ])
  })

  it('плечо в обратную сторону тоже годится', () => {
    // RUB → EUR: рубль в доллар — перевёрнутый курс, доллар в евро — перевёрнутый.
    const path = findPath(paired, 'RUB', 'EUR', '2026-09-01')
    expect(path?.rate).toBeCloseTo(1 / 108, 12)
    expect(path?.legs.every((leg) => leg.inverted)).toBe(true)
  })

  it('прямой курс главнее пути, даже если он старше', () => {
    const withDirect = [...paired, rate('2026-08-20', 'BTC', 'RUB', 5000000)]
    const path = findPath(withDirect, 'BTC', 'RUB', '2026-09-01')
    expect(path?.legs).toHaveLength(1)
    expect(path?.rate).toBe(5000000)
  })

  it('каждое плечо стареет само: старше срока — пути нет', () => {
    const stale = [rate('2026-07-01', 'USD', 'RUB', 80), rate('2026-09-01', 'BTC', 'USD', 60000)]
    expect(findPath(stale, 'BTC', 'RUB', '2026-09-01')).toBeNull()
  })

  it('из нескольких путей — тот, у которого старший курс свежее', () => {
    const two = [
      rate('2026-09-01', 'BTC', 'USD', 60000),
      rate('2026-08-10', 'USD', 'RUB', 80),
      rate('2026-09-01', 'BTC', 'USDT', 61000),
      rate('2026-08-25', 'USDT', 'RUB', 85),
    ]
    const path = findPath(two, 'BTC', 'RUB', '2026-09-01')
    expect(path?.legs[0]?.to).toBe('USDT')
  })

  it('равные по свежести пути — по коду валюты, одинаково на всех устройствах', () => {
    const two = [
      rate('2026-09-01', 'BTC', 'USDT', 61000),
      rate('2026-09-01', 'USDT', 'RUB', 85),
      rate('2026-09-01', 'BTC', 'USD', 60000),
      rate('2026-09-01', 'USD', 'RUB', 80),
    ]
    expect(findPath(two, 'BTC', 'RUB', '2026-09-01')?.legs[0]?.to).toBe('USD')
    expect(findPath([...two].reverse(), 'BTC', 'RUB', '2026-09-01')?.legs[0]?.to).toBe('USD')
  })

  it('промежуточная валюта одна: цепочку в три плеча не строит', () => {
    const chain = [
      rate('2026-09-01', 'BTC', 'USDT', 61000),
      rate('2026-09-01', 'USDT', 'USD', 1),
      rate('2026-09-01', 'USD', 'RUB', 90),
    ]
    expect(findPath(chain, 'BTC', 'RUB', '2026-09-01')).toBeNull()
  })

  it('удалённый курс не участвует ни прямо, ни в пути', () => {
    const gone = paired.map((each) => (each.from === 'USD' ? { ...each, deleted: true } : each))
    expect(findPath(gone, 'BTC', 'RUB', '2026-09-01')).toBeNull()
    expect(findRate(gone, 'USD', 'RUB', '2026-09-01')).toBeNull()
  })

  it('пересчёт через путь: 0,01 BTC по 60 000 $ и 90 ₽ = 54 000 ₽', () => {
    const result = convert({ amount: 1000000, currency: 'BTC' }, 'RUB', 2, 8, paired, '2026-09-01')
    expect(result).toMatchObject({ money: { amount: 5400000, currency: 'RUB' } })
    expect('legs' in result && result.legs).toHaveLength(2)
  })
})
