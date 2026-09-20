import { describe, expect, it } from 'vitest'
import type { Currency, Entry, Rate } from '../../app/model.ts'
import {
  DAYS_IN_MONTH,
  monthlyExpenses,
  monthReport,
  observations,
  overUsual,
  perMonth,
  usualMonth,
  USUAL_MONTHS,
  type MonthData,
} from './month.ts'

/** Суммы и категории выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const RUB: Currency = { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }
const USD: Currency = { id: 'c2', updatedAt: AT, code: 'USD', name: 'Доллар', decimals: 2, order: 1 }

let seq = 0
function entry(fields: Partial<Entry> & { kind: Entry['kind']; amount: number }): Entry {
  const { amount, ...rest } = fields
  return {
    id: `e-${++seq}`,
    updatedAt: AT,
    accountId: 'acc',
    money: { amount, currency: 'RUB' },
    ...rest,
  } as Entry
}

function data(entries: Entry[], rates: Rate[] = []): MonthData {
  return { entries, currencies: [RUB, USD], rates, base: 'RUB' }
}

describe('отчёт месяца', () => {
  const list = [
    entry({ kind: 'income', amount: 20000000, date: '2026-09-05' }),
    entry({ kind: 'expense', amount: 500000, date: '2026-09-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 300000, date: '2026-09-12', categoryId: 'ride' }),
    entry({ kind: 'expense', amount: 9000000, date: '2026-09-15', categoryId: 'tech', special: true }),
    entry({ kind: 'transfer', amount: 1000000, date: '2026-09-16' }),
  ]

  it('перевод не входит ни в доход, ни в расход', () => {
    const report = monthReport(data(list), '2026-09')
    expect(report.income.amount).toBe(20000000)
    expect(report.expense.amount).toBe(9800000)
    expect(report.transfers).toBe(1)
  })

  it('особая трата в расход входит, в обычный — нет', () => {
    const report = monthReport(data(list), '2026-09')
    expect(report.specialExpense.amount).toBe(9000000)
    expect(report.usualExpense.amount).toBe(800000)
  })

  it('отложено и норма сбережений считаются от всего расхода', () => {
    const report = monthReport(data(list), '2026-09')
    expect(report.saved).toBe(10200000)
    expect(report.savingsRate).toBeCloseTo(0.51, 5)
  })

  it('дохода нет — отложенного не существует, и это не ноль (Р-07)', () => {
    const noIncome = list.filter((each) => each.kind !== 'income')
    const report = monthReport(data(noIncome), '2026-09')
    expect(report.income.entries).toBe(0)
    expect(report.saved).toBeNull()
    expect(report.savingsRate).toBeNull()
  })

  it('каждое число знает, по скольким записям оно посчитано', () => {
    const report = monthReport(data(list), '2026-09')
    expect(report.expense.entries).toBe(3)
    expect(report.income.entries).toBe(1)
  })

  it('записи чужих месяцев не в счёт', () => {
    const report = monthReport(data(list), '2026-08')
    expect(report.expense.entries).toBe(0)
    expect(report.income.entries).toBe(0)
  })

  it('надгробие в итог не входит', () => {
    const gone = [...list, entry({ kind: 'expense', amount: 5000000, date: '2026-09-11', deleted: true })]
    expect(monthReport(data(gone), '2026-09').expense.amount).toBe(9800000)
  })
})

describe('итог периода по месяцам не дробится (Р-12, п. 6)', () => {
  const covered = [
    entry({ kind: 'expense', amount: 9000000, period: { from: '2026-08-20', to: '2026-09-25' } }),
    entry({ kind: 'expense', amount: 100000, date: '2026-09-10', categoryId: 'food' }),
  ]

  it('число из чужого периода в месяц не попадает', () => {
    const report = monthReport(data(covered), '2026-09')
    expect(report.expense.amount).toBe(100000)
  })

  it('но месяц называет, каким периодом он покрыт', () => {
    const report = monthReport(data(covered), '2026-09')
    expect(report.periodTotals.map((each) => each.period?.to)).toEqual(['2026-09-25'])
    expect(monthReport(data(covered), '2026-08').periodTotals).toHaveLength(1)
  })
})

describe('позиция без курса называется, а не пропадает (Р-04)', () => {
  const mixed = [
    entry({ kind: 'expense', amount: 100000, date: '2026-09-10' }),
    { ...entry({ kind: 'expense', amount: 5000, date: '2026-09-11' }), money: { amount: 5000, currency: 'USD' } },
  ]

  it('без курса сумма в итог не входит и названа', () => {
    const report = monthReport(data(mixed), '2026-09')
    expect(report.expense.amount).toBe(100000)
    expect(report.expense.entries).toBe(1)
    expect(report.expense.missing).toEqual([{ currency: 'USD', date: '2026-09-11', count: 1 }])
  })

  it('с курсом на дату входит и ничего не пропущено', () => {
    const rate: Rate = { id: 'r', updatedAt: AT, date: '2026-09-11', from: 'USD', to: 'RUB', rate: 80, source: 'manual' }
    const report = monthReport(data(mixed, [rate]), '2026-09')
    expect(report.expense.amount).toBe(500000)
    expect(report.expense.missing).toHaveLength(0)
  })

  it('одинаковой нехватки не набирается список из ста строк', () => {
    const many = [
      { ...entry({ kind: 'expense', amount: 1, date: '2026-09-11' }), money: { amount: 1, currency: 'USD' } },
      { ...entry({ kind: 'expense', amount: 2, date: '2026-09-11' }), money: { amount: 2, currency: 'USD' } },
    ]
    expect(monthReport(data(many), '2026-09').expense.missing).toEqual([
      { currency: 'USD', date: '2026-09-11', count: 2 },
    ])
  })
})

describe('приведение промежутка к месяцу', () => {
  it('месяц в 30,44 дня — сам себе равен', () => {
    expect(DAYS_IN_MONTH).toBe(30.44)
    const month = perMonth(3044000, { from: '2026-09-01', to: '2026-09-30' })
    expect(month).toBe(Math.round((3044000 / 30) * DAYS_IN_MONTH))
  })

  it('период длиннее месяца даёт расход меньше своего итога', () => {
    const long = perMonth(6000000, { from: '2026-01-05', to: '2026-02-14' })
    expect(long).toBeLessThan(6000000)
  })

  it('период в один день не делится на ноль', () => {
    expect(perMonth(1000, { from: '2026-01-05', to: '2026-01-05' })).toBe(Math.round(1000 * DAYS_IN_MONTH))
  })
})

describe('обычный месяц (Р-07)', () => {
  const history = [
    entry({ kind: 'expense', amount: 1000000, date: '2026-06-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 2000000, date: '2026-07-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 3000000, date: '2026-08-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 9000000, date: '2026-09-10', categoryId: 'food' }),
  ]

  it('считается по прошлым месяцам, не включая этот', () => {
    const { list } = observations(data(history), '2026-09')
    expect(list.map((each) => each.label)).toEqual(['2026-08', '2026-07', '2026-06'])
    expect(usualMonth(list)?.monthly).toBe(2000000)
  })

  it('месяц без записей наблюдением не становится: он значит «не вносил»', () => {
    const gap = history.filter((each) => each.date !== '2026-07-10')
    const { list } = observations(data(gap), '2026-09')
    expect(list).toHaveLength(2)
    expect(usualMonth(list)?.months).toBe(2)
  })

  it('особые траты в обычный месяц не идут', () => {
    const withSpecial = [...history, entry({ kind: 'expense', amount: 50000000, date: '2026-08-15', special: true })]
    const { list } = observations(data(withSpecial), '2026-09')
    expect(usualMonth(list)?.monthly).toBe(2000000)
  })

  it('итоги периодов — тоже наблюдения: на них стоит история таблицы', () => {
    const table = [
      entry({ kind: 'expense', amount: 6000000, period: { from: '2026-01-05', to: '2026-02-14' } }),
      entry({ kind: 'expense', amount: 3000000, date: '2026-08-10' }),
    ]
    const { list } = observations(data(table), '2026-09')
    expect(list.map((each) => each.kind).sort()).toEqual(['month', 'period'])
    expect(usualMonth(list)?.periods).toBe(1)
  })

  it('наблюдений нет — обычного месяца нет, а не ноль', () => {
    expect(usualMonth([])).toBeNull()
  })

  it('берётся ровно столько месяцев, сколько сказано константой', () => {
    expect(USUAL_MONTHS).toBe(6)
    const long = Array.from({ length: 12 }, (_, at) =>
      entry({ kind: 'expense', amount: 1000000, date: `2026-${String(at + 1).padStart(2, '0')}-10` }),
    )
    expect(observations(data(long), '2026-12').list.filter((each) => each.kind === 'month')).toHaveLength(USUAL_MONTHS)
  })
})

describe('вышло за обычное (Р-07)', () => {
  const list = [
    entry({ kind: 'expense', amount: 100000, date: '2026-07-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 100000, date: '2026-08-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 50000, date: '2026-07-11', categoryId: 'ride' }),
    entry({ kind: 'expense', amount: 50000, date: '2026-08-11', categoryId: 'ride' }),
    entry({ kind: 'expense', amount: 400000, date: '2026-09-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 50000, date: '2026-09-11', categoryId: 'ride' }),
  ]

  it('наибольшее отклонение — первым, и оно знает своё основание', () => {
    const rows = overUsual(data(list), '2026-09')
    expect(rows[0]?.categoryId).toBe('food')
    expect(rows[0]?.now).toBe(400000)
    expect(rows[0]?.usual).toBe(100000)
    expect(rows[0]?.delta).toBe(300000)
    expect(rows[0]?.months).toBe(2)
  })

  it('категория, совпавшая с обычной, в список не идёт', () => {
    expect(overUsual(data(list), '2026-09').some((each) => each.categoryId === 'ride')).toBe(false)
  })

  it('прошлого нет — сравнивать не с чем, и список пуст', () => {
    const only = list.filter((each) => each.date?.startsWith('2026-09'))
    expect(overUsual(data(only), '2026-09')).toEqual([])
  })

  it('расход без категории не прячется', () => {
    const noCategory = [
      entry({ kind: 'expense', amount: 100000, date: '2026-08-10' }),
      entry({ kind: 'expense', amount: 900000, date: '2026-09-10' }),
    ]
    const rows = overUsual(data(noCategory), '2026-09')
    expect(rows[0]?.categoryId).toBeNull()
    expect(rows[0]?.delta).toBe(800000)
  })
})

describe('столбики по месяцам', () => {
  it('идут от старых к новым и считают весь расход месяца', () => {
    const list = [
      entry({ kind: 'expense', amount: 100000, date: '2026-08-10' }),
      entry({ kind: 'expense', amount: 200000, date: '2026-09-10' }),
    ]
    expect(monthlyExpenses(data(list), '2026-09', 3)).toEqual([
      { month: '2026-07', amount: 0 },
      { month: '2026-08', amount: 100000 },
      { month: '2026-09', amount: 200000 },
    ])
  })
})
