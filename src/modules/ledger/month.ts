/**
 * «Месяц»: сколько отложено и хватает ли дохода (Р-07).
 *
 * Главный вопрос приложения, ради которого оно и заводилось. Чистые функции
 * с тестами, без React и без базы: экран только показывает то, что посчитано
 * здесь.
 *
 * Правила, которые здесь держатся:
 *
 * — **Каждое число — с основанием** (Р-07): не «отложено 18%», а «отложено
 *   18% — по 142 операциям». Позиция, которая в итог не вошла, называется,
 *   а не пропадает молча (Р-04).
 * — **Доход не внесён — так и сказано,** а не показан ноль: ноль значил бы
 *   «я ничего не заработал», и это была бы неправда.
 * — **Итог периода по месяцам не дробится** (Р-12, п. 6). Месяц числа из
 *   чужого периода не берёт вовсе; сопоставимость даёт расход в день,
 *   приведённый к `DAYS_IN_MONTH`, — и только там, где сравниваются
 *   промежутки между собой.
 * — **Перевод между своими счетами — не расход и не доход** (Р-12, п. 3):
 *   в итоги он не входит никогда.
 * — **Обычный месяц — без особых трат** (Р-05, Р-07).
 */

import { daysBetween } from '../../shared/core/dates.ts'
import type { Currency, Entry, Money, Rate } from '../../app/model.ts'
import { convert } from '../money/rates.ts'

/** Сколько прошлых месяцев берёт «обычный месяц». Число видно в основании и в справке. */
export const USUAL_MONTHS = 6

/**
 * Средняя длина месяца в днях: 365,25 / 12. Ею промежутки приводятся
 * к месяцу, чтобы период в 41 день и месяц в 31 можно было сравнить
 * (Р-12, п. 6).
 */
export const DAYS_IN_MONTH = 30.44

/** Сколько категорий показывать в «вышло за обычное». */
export const OVER_USUAL_SHOWN = 5

/** Позиция, которая в итог не вошла: нет курса на дату (Р-04). */
export type Missing = { currency: string; date: string; count: number }

/** Итог вместе с основанием: по скольким записям и чего не хватило. */
export type Sum = {
  /** В базовой валюте. */
  amount: number
  /** По скольким записям посчитано. */
  entries: number
  missing: Missing[]
}

type Converted = { entry: Entry; amount: number } | { entry: Entry; missing: Missing }

/** Всё, что нужно расчёту. Записи — уже без надгробий. */
export type MonthData = {
  entries: readonly Entry[]
  currencies: readonly Currency[]
  rates: readonly Rate[]
  base: string
}

function decimalsOf(currencies: readonly Currency[], code: string): number | null {
  return currencies.find((each) => !each.deleted && each.code === code)?.decimals ?? null
}

/**
 * Сумма записи в базовой валюте на дату записи (Р-04).
 *
 * Курс берётся на дату события, а не сегодняшний: вопрос «сколько это
 * стоило тогда», а не «сколько бы стоило сейчас».
 */
function toBase(entry: Entry, data: MonthData): Converted {
  const day = entry.date ?? entry.period?.to ?? ''
  if (entry.money.currency === data.base) return { entry, amount: entry.money.amount }

  const to = decimalsOf(data.currencies, data.base)
  const from = decimalsOf(data.currencies, entry.money.currency)
  if (to === null || from === null) {
    return { entry, missing: { currency: entry.money.currency, date: day, count: 1 } }
  }

  const result = convert(entry.money, data.base, to, from, data.rates, day)
  if ('missing' in result) {
    return { entry, missing: { currency: result.missing.from, date: result.missing.date, count: 1 } }
  }
  return { entry, amount: result.money.amount }
}

function sumOf(entries: readonly Entry[], data: MonthData): Sum {
  const missing = new Map<string, Missing>()
  let amount = 0
  let counted = 0

  for (const entry of entries) {
    const result = toBase(entry, data)
    if ('missing' in result) {
      const key = `${result.missing.currency}:${result.missing.date}`
      const was = missing.get(key)
      if (was) was.count += 1
      else missing.set(key, { ...result.missing })
      continue
    }
    amount += result.amount
    counted += 1
  }

  return { amount, entries: counted, missing: [...missing.values()] }
}

// ─── Отбор записей ─────────────────────────────────────────────────────────

/** Операции месяца: по дате. Итоги периодов сюда не входят — они не дробятся. */
function operationsOf(entries: readonly Entry[], month: string): Entry[] {
  return entries.filter((each) => !each.deleted && each.date?.startsWith(`${month}-`))
}

/** Итоги периодов, задевающие месяц. Числами месяца они не становятся. */
function totalsTouching(entries: readonly Entry[], month: string): Entry[] {
  const from = `${month}-01`
  const to = `${month}-31`
  return entries.filter((each) => !each.deleted && each.period && each.period.from <= to && from <= each.period.to)
}

// ─── Отчёт месяца ──────────────────────────────────────────────────────────

export type MonthReport = {
  month: string
  /** Доход месяца. `entries` = 0 — доход не внесён, и это не ноль. */
  income: Sum
  /** Весь расход месяца, вместе с особыми. */
  expense: Sum
  /** Расход без особых — то, из чего складывается обычный месяц. */
  usualExpense: Sum
  /** Особые траты: в расход месяца входят, в обычный месяц — нет. */
  specialExpense: Sum
  /** Доход − расход. Считать нельзя — null, и `savedProblem` говорит почему. */
  saved: number | null
  /** Почему отложенное не посчитано. Null — посчитано. */
  savedProblem: SavedProblem
  /** Отложено / доход. Дохода нет или он нулевой — null. */
  savingsRate: number | null
  /** Переводы месяца: не расход и не доход, но их видно числом. */
  transfers: number
  /** Итоги периодов, задевающие месяц: месяц называет их, а не считает. */
  periodTotals: Entry[]
}

/**
 * Почему отложенное не посчитано.
 *
 * — `no-income` — доход за месяц не внесён: вычитать не из чего;
 * — `covered` — расход месяца записан итогом за период, а не операциями.
 *   Помесячно он неизвестен, и вычесть его из дохода нельзя (Р-12, п. 6).
 *   Без этого «отложено» показало бы весь доход как отложенный — число
 *   уверенное и неверное.
 */
export type SavedProblem = 'no-income' | 'covered' | null

export function monthReport(data: MonthData, month: string): MonthReport {
  const operations = operationsOf(data.entries, month)

  const income = sumOf(operations.filter((each) => each.kind === 'income'), data)
  const expenses = operations.filter((each) => each.kind === 'expense')
  const expense = sumOf(expenses, data)
  const usualExpense = sumOf(expenses.filter((each) => !each.special), data)
  const specialExpense = sumOf(expenses.filter((each) => each.special === true), data)

  const periodTotals = totalsTouching(data.entries, month)

  // Расход месяца записан периодом — помесячно он неизвестен, и вычитать
  // его из дохода нельзя. Иначе отложенным окажется весь доход.
  // Доход не внесён — отложенного тоже не существует: ноль здесь означал бы
  // «ничего не отложено», а правда в том, что считать не из чего (Р-07).
  const covered = periodTotals.some((each) => each.kind === 'expense')
  const savedProblem: SavedProblem = covered ? 'covered' : income.entries === 0 ? 'no-income' : null

  const saved = savedProblem === null ? income.amount - expense.amount : null
  const savingsRate = saved === null || income.amount === 0 ? null : saved / income.amount

  return {
    month,
    income,
    expense,
    usualExpense,
    specialExpense,
    saved,
    savedProblem,
    savingsRate,
    transfers: operations.filter((each) => each.kind === 'transfer').length,
    periodTotals,
  }
}

// ─── Обычный месяц ─────────────────────────────────────────────────────────

/**
 * Одно наблюдение для «обычного месяца»: месяц или промежуток, приведённый
 * к месяцу.
 *
 * Промежутки нужны потому, что история прежней таблицы — это итоги периодов,
 * а не месяцы (Р-12, п. 6): часть длиннее месяца, часть короче. Деление их
 * по дням выдумало бы месяцы, которых не было; расход в день ничего
 * не выдумывает.
 */
export type Observation = {
  kind: 'month' | 'period'
  /** Чем это называть человеку: «2026-08» или «05.01.2026 — 14.02.2026». */
  label: string
  /** Расход, приведённый к месяцу, в базовой валюте. */
  monthly: number
}

/** Обычный месяц: средний расход без особых — и по чему он посчитан (Р-07). */
export type Usual = {
  monthly: number
  months: number
  periods: number
  /** Позиции, не вошедшие в расчёт: нет курса. */
  missing: Missing[]
}

/**
 * Наблюдения за `count` месяцев до `month` — не включая его самого.
 *
 * Месяц без единой записи наблюдением не становится: он означает «я тогда
 * не вносил», а не «я тогда не тратил», и в среднем занизил бы обычный месяц.
 */
export function observations(
  data: MonthData,
  month: string,
  count: number = USUAL_MONTHS,
): { list: Observation[]; missing: Missing[] } {
  const found: Observation[] = []
  const missing: Missing[] = []

  let cursor = month
  for (let step = 0; step < count; step++) {
    cursor = previousMonth(cursor)
    const expenses = operationsOf(data.entries, cursor).filter((each) => each.kind === 'expense' && !each.special)
    if (expenses.length === 0) continue
    const sum = sumOf(expenses, data)
    missing.push(...sum.missing)
    if (sum.entries > 0) found.push({ kind: 'month', label: cursor, monthly: sum.amount })
  }

  // Итоги периодов, кончившиеся раньше этого месяца, — тоже наблюдения:
  // на них стоит вся история прежней таблицы.
  const totals = data.entries.filter(
    (each) => !each.deleted && each.kind === 'expense' && !each.special && each.period && each.period.to < `${month}-01`,
  )
  for (const total of totals.slice(-count)) {
    const period = total.period
    if (!period) continue
    const result = toBase(total, data)
    if ('missing' in result) continue
    found.push({
      kind: 'period',
      label: `${period.from} — ${period.to}`,
      monthly: perMonth(result.amount, period),
    })
  }

  return { list: found, missing }
}

/** Расход промежутка, приведённый к месяцу в 30,44 дня (Р-12, п. 6). */
export function perMonth(amount: number, period: { from: string; to: string }): number {
  // Границы включительно: период «5 января — 5 января» — это один день,
  // а не ноль, и делить на ноль тут нечего.
  const days = daysBetween(period.from, period.to) + 1
  if (days <= 0) return amount
  return Math.round((amount / days) * DAYS_IN_MONTH)
}

/** Средний расход по наблюдениям. Наблюдений нет — null: считать не по чему. */
export function usualMonth(list: readonly Observation[], missing: readonly Missing[] = []): Usual | null {
  if (list.length === 0) return null
  const total = list.reduce((all, each) => all + each.monthly, 0)
  return {
    monthly: Math.round(total / list.length),
    months: list.filter((each) => each.kind === 'month').length,
    periods: list.filter((each) => each.kind === 'period').length,
    missing: [...missing],
  }
}

// ─── «Вышло за обычное» ────────────────────────────────────────────────────

/** Категория, в которой этот месяц разошёлся с обычным. */
export type OverUsual = {
  categoryId: string | null
  /** Расход этого месяца в базовой валюте. */
  now: number
  /** Обычный расход по этой категории. */
  usual: number
  /** Насколько больше обычного. Отрицательное — меньше обычного. */
  delta: number
  /** По скольким прошлым месяцам посчитано обычное. */
  months: number
}

/**
 * Что вышло за обычное: категории с наибольшим отклонением от обычного
 * месяца (Р-07).
 *
 * Отвечает на «куда уходит» не списком долей, как таблица, а отклонением:
 * доля категории действия не даёт, а «в этом месяце на транспорт вдвое
 * больше обычного» — даёт.
 *
 * Считается только по месяцам: у итогов периодов категории чаще нет вовсе
 * (Р-12, п. 6), и разложить их по категориям не из чего.
 */
export function overUsual(
  data: MonthData,
  month: string,
  count: number = USUAL_MONTHS,
  shown: number = OVER_USUAL_SHOWN,
): OverUsual[] {
  const past: string[] = []
  let cursor = month
  for (let step = 0; step < count; step++) {
    cursor = previousMonth(cursor)
    if (operationsOf(data.entries, cursor).some((each) => each.kind === 'expense')) past.push(cursor)
  }
  if (past.length === 0) return []

  const now = byCategory(operationsOf(data.entries, month), data)
  const before = new Map<string, number>()
  for (const each of past) {
    for (const [categoryId, amount] of byCategory(operationsOf(data.entries, each), data)) {
      before.set(categoryId, (before.get(categoryId) ?? 0) + amount)
    }
  }

  const categories = new Set([...now.keys(), ...before.keys()])
  const rows: OverUsual[] = []
  for (const categoryId of categories) {
    const thisMonth = now.get(categoryId) ?? 0
    const usual = Math.round((before.get(categoryId) ?? 0) / past.length)
    if (thisMonth === usual) continue
    rows.push({
      categoryId: categoryId === NO_CATEGORY ? null : categoryId,
      now: thisMonth,
      usual,
      delta: thisMonth - usual,
      months: past.length,
    })
  }

  return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, shown)
}

/** Ключ для расходов, у которых категории нет: в разбивке они не прячутся. */
const NO_CATEGORY = '—'

/** Обычный расход по категориям: особые не в счёт (Р-05). */
function byCategory(entries: readonly Entry[], data: MonthData): Map<string, number> {
  const sums = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== 'expense' || entry.special) continue
    const result = toBase(entry, data)
    if ('missing' in result) continue
    const key = entry.categoryId ?? NO_CATEGORY
    sums.set(key, (sums.get(key) ?? 0) + result.amount)
  }
  return sums
}

// ─── Месяцы ────────────────────────────────────────────────────────────────

function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const number = Number(month.slice(5, 7))
  if (number > 1) return `${year}-${String(number - 1).padStart(2, '0')}`
  return `${year - 1}-12`
}

/** Столбики по месяцам: расход каждого месяца в базовой валюте (`BarChart` ядра). */
export function monthlyExpenses(data: MonthData, month: string, count: number): { month: string; amount: number }[] {
  const bars: { month: string; amount: number }[] = []
  let cursor = month
  for (let step = 0; step < count; step++) {
    const expenses = operationsOf(data.entries, cursor).filter((each) => each.kind === 'expense')
    bars.unshift({ month: cursor, amount: sumOf(expenses, data).amount })
    cursor = previousMonth(cursor)
  }
  return bars
}

/** Сумма в базовой валюте — для показа. */
export function inBase(amount: number, base: string): Money {
  return { amount, currency: base }
}
