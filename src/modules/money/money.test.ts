import { describe, expect, it } from 'vitest'
import type { Currency, Money } from '../../app/model.ts'
import {
  currencyProblem,
  findCurrency,
  formatMoney,
  MAX_DECIMALS,
  parseAmount,
  parseShown,
  shownValue,
  suggestDecimals,
  sumMoney,
  toMajor,
} from './money.ts'

/** Валюты примеров выдуманы ровно настолько, насколько это возможно: коды настоящие, суммы — нет. */
function currency(fields: Partial<Currency> & { code: string; decimals: number }): Currency {
  return {
    id: `id-${fields.code}`,
    updatedAt: '2026-09-20T10:00:00.000Z',
    name: fields.code,
    order: 0,
    ...fields,
  }
}

const rub = currency({ code: 'RUB', decimals: 2, name: 'Рубль' })
const btc = currency({ code: 'BTC', decimals: 8, name: 'Биткойн', unit: { name: 'mBTC', factor: 100000 } })
const usdt = currency({ code: 'USDT', decimals: 4, name: 'Тезер' })

describe('разбор суммы из обычных единиц', () => {
  it('переводит в минимальные единицы: рубли и копейки', () => {
    expect(parseAmount('1234.56', 2)).toEqual({ amount: 123456, rounded: false })
    expect(parseAmount(1234.56, 2)).toEqual({ amount: 123456, rounded: false })
  })

  it('терпит запятую и пробелы, которыми банк разделяет тысячи', () => {
    expect(parseAmount('1 234,56', 2)).toEqual({ amount: 123456, rounded: false })
    expect(parseAmount('1 234,56', 2)).toEqual({ amount: 123456, rounded: false })
  })

  it('не теряет копейку на двоичной дроби: 1.005 — это 101, а не 100', () => {
    // Через умножение вышло бы 100: 1.005 * 100 === 100.49999999999999.
    expect(parseAmount('1.005', 2)).toEqual({ amount: 101, rounded: true })
  })

  it('лишние знаки округляет и говорит об этом', () => {
    expect(parseAmount('10.999', 2)).toEqual({ amount: 1100, rounded: true })
    expect(parseAmount('10.10', 2)).toEqual({ amount: 1010, rounded: false })
    expect(parseAmount('10.100', 2)).toEqual({ amount: 1010, rounded: false })
  })

  it('знает нулевые знаки и восемь знаков крипты', () => {
    expect(parseAmount('1200', 0)).toEqual({ amount: 1200, rounded: false })
    expect(parseAmount('0.00000001', 8)).toEqual({ amount: 1, rounded: false })
  })

  it('минус — отказ: направление задаёт вид записи, а не знак суммы', () => {
    expect(parseAmount('-500', 2)).toBeNull()
  })

  it('не число — отказ, а не ноль', () => {
    expect(parseAmount('', 2)).toBeNull()
    expect(parseAmount('около тысячи', 2)).toBeNull()
    expect(parseAmount('1.2.3', 2)).toBeNull()
  })

  it('знаков больше восьми не бывает', () => {
    expect(parseAmount('1.5', MAX_DECIMALS + 1)).toBeNull()
  })

  it('обратно в обычные единицы', () => {
    expect(toMajor(123456, 2)).toBe(1234.56)
    expect(toMajor(1, 8)).toBe(1e-8)
  })
})

describe('показ суммы', () => {
  /** Intl разделяет разряды неразрывными пробелами; их вид зависит от версии ICU, а не от нас. */
  const shown = (money: Money, currency: Currency | null) =>
    formatMoney(money, currency).replace(/[  ]/g, ' ')

  it('рубли — со знаком валюты', () => {
    expect(shown({ amount: 123456, currency: 'RUB' }, rub)).toBe('1 234,56 ₽')
  })

  it('крипта — в единице показа: сатоши хранятся, mBTC показываются', () => {
    // 2 163 000 сатоши = 0,02163 BTC = 21,63 mBTC.
    expect(shown({ amount: 2163000, currency: 'BTC' }, btc)).toBe('21,630 mBTC')
  })

  it('валюта без знака в Intl показывается кодом, а не прячется', () => {
    expect(shown({ amount: 1800000, currency: 'USDT' }, usdt)).toBe('180,0000 USDT')
  })

  it('валюты нет в справочнике — показываем как есть, а не молчим', () => {
    expect(formatMoney({ amount: 500, currency: 'XXX' }, null)).toBe('500 XXX')
  })
})

describe('справочник валют', () => {
  it('подсказка знаков: у рубля два, у йены ноль', () => {
    expect(suggestDecimals('RUB')).toBe(2)
    expect(suggestDecimals('JPY')).toBe(0)
  })

  it('Intl не знает USDT — подсказка не падает', () => {
    expect(suggestDecimals('USDT')).toBe(2)
  })

  it('находит валюту по коду', () => {
    expect(findCurrency([rub, btc], 'BTC')).toBe(btc)
    expect(findCurrency([rub, btc], 'EUR')).toBeNull()
  })

  it('ловит негодную запись валюты и называет причину', () => {
    expect(currencyProblem(rub)).toBeNull()
    expect(currencyProblem(currency({ code: 'XAU', decimals: 9 }))).toContain('от 0 до 8')
    expect(currencyProblem(currency({ code: 'XAU', decimals: 1.5 }))).toContain('не целое')
    expect(currencyProblem(currency({ code: ' ', decimals: 2 }))).toContain('нет кода')
  })
})

describe('сложение', () => {
  const money = (amount: number, code = 'RUB'): Money => ({ amount, currency: code })

  it('складывает одну валюту', () => {
    expect(sumMoney([money(100), money(250)], 'RUB')).toEqual({ money: money(350) })
  })

  it('пустой список — ноль в своей валюте', () => {
    expect(sumMoney([], 'RUB')).toEqual({ money: money(0) })
  })

  it('чужая валюта не складывается молча — она названа', () => {
    const result = sumMoney([money(100), money(50, 'USD'), money(20, 'EUR')], 'RUB')
    expect(result).toEqual({ mixed: ['USD', 'EUR'] })
  })
})

describe('сумма в поле ввода — в единице показа', () => {
  it('mBTC разбирается в сатоши без потери знаков', () => {
    expect(parseShown('21,63', btc)).toEqual({ amount: 2163000, rounded: false })
    expect(parseShown('0,00001', btc)).toEqual({ amount: 1, rounded: false })
  })

  it('без единицы показа — обычные единицы валюты', () => {
    expect(parseShown('1 234,56', rub)).toEqual({ amount: 123456, rounded: false })
  })

  it('знак и не число — отказ', () => {
    expect(parseShown('-5', rub)).toBeNull()
    expect(parseShown('пять', btc)).toBeNull()
  })

  it('обратно в поле — без группировки и лишних нулей', () => {
    expect(shownValue(2163000, btc)).toBe('21,63')
    expect(shownValue(123450, rub)).toBe('1234,5')
    expect(shownValue(500000, rub)).toBe('5000')
    expect(shownValue(1, usdt)).toBe('0,0001')
  })

  it('туда и обратно — то же самое', () => {
    for (const amount of [0, 1, 99, 2163000, 123456789]) {
      expect(parseShown(shownValue(amount, btc), btc)?.amount).toBe(amount)
      expect(parseShown(shownValue(amount, rub), rub)?.amount).toBe(amount)
    }
  })
})
