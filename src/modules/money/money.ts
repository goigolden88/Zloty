/**
 * Деньги: суммы, валюты, разбор и показ (Р-04).
 *
 * Общая библиотека: её знают все модули, она — ни одного. Деньги, валюты
 * и курсы — своё, а не ядро (Р-03): остальным приложениям семьи они не нужны.
 *
 * Правило одно и держится здесь: **сумма — целое число в минимальных
 * единицах валюты вместе с её кодом**. Дробных сумм в модели нет; дробный —
 * только курс (`rates.ts`).
 */

import type { Currency, CurrencyCode, Money } from '../../app/model.ts'

/**
 * Больше восьми знаков не бывает: 21 миллион BTC в сатоши — это уже 2.1e15,
 * а целые числа JavaScript точны до 9e15. Ещё два знака — и сложение начнёт
 * терять хвост молча (Р-04).
 */
export const MAX_DECIMALS = 8

/** Сколько знаков у валюты по умолчанию, если Intl про неё не знает. */
export const DEFAULT_DECIMALS = 2

// ─── Справочник валют ──────────────────────────────────────────────────────

/**
 * Подсказка при заведении валюты: сколько знаков у неё по ISO 4217.
 *
 * Хранится всё равно в записи валюты (Р-12): для крипты и стейблкоинов
 * Intl ничего не знает, а правка кода ради новой валюты — то, чего Р-04
 * не хотел. Здесь только подсказка для формы.
 */
export function suggestDecimals(code: CurrencyCode): number {
  try {
    const options = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: code }).resolvedOptions()
    return options.maximumFractionDigits ?? DEFAULT_DECIMALS
  } catch {
    // Код не трёхбуквенный (USDT) или Intl его не знает — ничего страшного.
    return DEFAULT_DECIMALS
  }
}

/** Валюта по коду. Нет такой — null: звать её «рублём на всякий случай» нельзя. */
export function findCurrency(currencies: readonly Currency[], code: CurrencyCode): Currency | null {
  return currencies.find((currency) => currency.code === code) ?? null
}

/** Правильна ли запись валюты: знаки целые, от нуля до восьми. */
export function currencyProblem(currency: Currency): string | null {
  if (!currency.code.trim()) return 'у валюты нет кода'
  if (!Number.isInteger(currency.decimals)) return `${currency.code}: знаков после запятой — не целое число`
  if (currency.decimals < 0 || currency.decimals > MAX_DECIMALS) {
    return `${currency.code}: знаков после запятой ${currency.decimals}, а бывает от 0 до ${MAX_DECIMALS}`
  }
  if (currency.unit && !(currency.unit.factor > 0)) return `${currency.code}: множитель единицы показа — не число больше нуля`
  return null
}

// ─── Обычные единицы ↔ минимальные ─────────────────────────────────────────

/** Что получилось из строки суммы: число в минимальных единицах — и было ли округление. */
export type Parsed = { amount: number; rounded: boolean }

/**
 * Сумма из обычных единиц в минимальные: «1 234,56» при двух знаках → 123456.
 *
 * Разбор идёт по строке, а не умножением: `1.005 * 100` в двоичной дроби
 * даёт 100.49999999999999, и копейка теряется молча. Лишние знаки
 * округляются половиной вверх, и об этом говорит `rounded` — импорт обязан
 * назвать это в сводке (Р-08).
 *
 * Знака в сумме нет: направление задаёт вид записи (Р-12). Минус — отказ.
 */
export function parseAmount(value: string | number, decimals: number): Parsed | null {
  const text = String(value)
    .replace(/[\s  ]/g, '')
    .replace(',', '.')
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return null
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null

  const whole = match[1] ?? '0'
  const frac = match[2] ?? ''
  const kept = frac.slice(0, decimals).padEnd(decimals, '0')
  const dropped = frac.slice(decimals)

  let amount = Number(`${whole}${kept}`)
  const roundUp = (dropped[0] ?? '0') >= '5'
  if (roundUp) amount += 1

  if (!Number.isSafeInteger(amount)) return null
  return { amount, rounded: dropped.replace(/0+$/, '') !== '' }
}

/** Минимальные единицы в обычные: 123456 при двух знаках → 1234.56. Для показа и экспорта. */
export function toMajor(amount: number, decimals: number): number {
  return amount / 10 ** decimals
}

// ─── Показ ─────────────────────────────────────────────────────────────────

/**
 * Сумма словами человека: «1 234,56 ₽», «21,63 mBTC», «180,00 USDT».
 *
 * Единица показа — свойство валюты: BTC хранится в сатоши, показывается
 * в mBTC (Р-04). Валюты нет в справочнике — показываем число с кодом,
 * а не прячем сумму.
 */
export function formatMoney(money: Money, currency: Currency | null): string {
  if (!currency) return `${money.amount} ${money.currency}`

  if (currency.unit) {
    const value = money.amount / currency.unit.factor
    const digits = unitDecimals(currency)
    return `${formatNumber(value, digits)} ${currency.unit.name}`
  }

  const value = toMajor(money.amount, currency.decimals)
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: currency.code,
      minimumFractionDigits: currency.decimals,
      maximumFractionDigits: currency.decimals,
    }).format(value)
  } catch {
    // Код не по ISO 4217 — USDT, условные шекели. Знака у него нет, и это
    // не повод не показать сумму.
    return `${formatNumber(value, currency.decimals)} ${currency.code}`
  }
}

/**
 * Сумма, которую человек вписал в поле, — в единице показа валюты, если она
 * есть: биткойн вносится в mBTC, как в таблице, а хранится в сатоши (Р-04).
 * Точность — полная: «21,63» mBTC — ровно 2 163 000 сатоши. Знака нет.
 */
export function parseShown(value: string, currency: Currency): Parsed | null {
  if (!currency.unit) return parseAmount(value, currency.decimals)
  const digits = Math.round(Math.log10(currency.unit.factor))
  // Множитель — степень десяти: тогда разбор с его числом знаков сразу даёт
  // минимальные единицы, без умножения дробей.
  if (digits >= 0 && 10 ** digits === currency.unit.factor) return parseAmount(value, digits)
  const parsed = parseAmount(value, MAX_DECIMALS)
  if (!parsed) return null
  const amount = Math.round((parsed.amount / 10 ** MAX_DECIMALS) * currency.unit.factor)
  return Number.isSafeInteger(amount) ? { amount, rounded: parsed.rounded } : null
}

/** Сумма для поля ввода — в единице показа, без группировки и без лишних нулей: «21,63». */
export function shownValue(amount: number, currency: Currency): string {
  const factor = currency.unit ? currency.unit.factor : 10 ** currency.decimals
  const digits = Math.max(0, Math.ceil(Math.log10(factor)))
  const text = (amount / factor).toFixed(Math.min(digits, 20))
  return (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text).replace('.', ',')
}

/** Сколько знаков показывать в единице показа: mBTC из сатоши — 3 знака, как закреплено тестом. */
function unitDecimals(currency: Currency): number {
  if (!currency.unit) return currency.decimals
  const shift = Math.round(Math.log10(currency.unit.factor))
  return Math.max(0, Math.min(MAX_DECIMALS, currency.decimals - shift))
}

function formatNumber(value: number, digits: number): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

// ─── Сложение ──────────────────────────────────────────────────────────────

/** Итог сложения: либо сумма, либо названные валюты, которые не сложились. */
export type SumResult = { money: Money } | { mixed: CurrencyCode[] }

/**
 * Сложить суммы одной валюты.
 *
 * Разные валюты не складываются без курса — и молча не складываются тоже:
 * функция возвращает их список, чтобы экран назвал его числом, а не показал
 * итог, которому нельзя верить (Р-04, Р-07).
 */
export function sumMoney(list: readonly Money[], currency: CurrencyCode): SumResult {
  const mixed = [...new Set(list.map((money) => money.currency))].filter((code) => code !== currency)
  if (mixed.length > 0) return { mixed }
  return { money: { amount: list.reduce((total, money) => total + money.amount, 0), currency } }
}
