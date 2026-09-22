import { describe, expect, it } from 'vitest'
import type { Category, Currency, Entry, Rate, Recurring } from '../../app/model.ts'
import { observations, usualMonth, type MonthData } from './month.ts'
import { needed, rareIds, rareOnes, shareOf, worksIn, type NeedData } from './need.ts'

/** Суммы, названия и курсы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const RUB: Currency = { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }
const USD: Currency = { id: 'c2', updatedAt: AT, code: 'USD', name: 'Доллар', decimals: 2, order: 1 }

const SPEND: Category = { id: 'cat-spend', updatedAt: AT, name: 'Страховка', side: 'expense', order: 0 }
const EARN: Category = { id: 'cat-earn', updatedAt: AT, name: 'Премия', side: 'income', order: 1 }

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

function template(over: Partial<Recurring> = {}): Recurring {
  return {
    id: 'r-osago',
    updatedAt: AT,
    name: 'ОСАГО',
    categoryId: SPEND.id,
    expected: { amount: 1200000, currency: 'RUB' },
    every: { months: 12 },
    from: '2026-01',
    order: 0,
    ...over,
  }
}

function data(over: Partial<NeedData> = {}): NeedData {
  return {
    entries: [],
    currencies: [RUB, USD],
    rates: [],
    base: 'RUB',
    recurring: [template()],
    categories: [SPEND, EARN],
    ...over,
  }
}

describe('какие шаблоны раскладываются по месяцам (Р-27)', () => {
  it('годовой расходный — да', () => {
    expect(rareOnes(data(), '2026-09').map((each) => each.name)).toEqual(['ОСАГО'])
  })

  it('ежемесячный — нет: он и так весь в обычном месяце', () => {
    const monthly = data({ recurring: [template({ every: { months: 1 } })] })
    expect(rareOnes(monthly, '2026-09')).toEqual([])
  })

  // Сторону говорит категория (Р-06): доходный шаблон в необходимый доход
  // не идёт, сколько бы раз в год он ни приходил.
  it('доходный — нет, даже редкий', () => {
    const income = data({ recurring: [template({ categoryId: EARN.id })] })
    expect(rareOnes(income, '2026-09')).toEqual([])
  })

  it('кончившийся — нет: страховка проданной машины денег не требует', () => {
    const over = data({ recurring: [template({ to: '2026-06' })] })
    expect(rareOnes(over, '2026-09')).toEqual([])
    expect(worksIn(template({ to: '2026-06' }), '2026-05')).toBe(true)
  })

  it('ещё не начавшийся — нет', () => {
    expect(rareOnes(data({ recurring: [template({ from: '2027-01' })] }), '2026-09')).toEqual([])
  })

  it('доля — ожидаемое, делённое на период', () => {
    expect(shareOf(template())).toEqual({ amount: 100000, currency: 'RUB' })
  })
})

describe('необходимый доход (Р-07, Р-27)', () => {
  const usual = usualMonth([
    { kind: 'month', label: '2026-06', monthly: 3000000 },
    { kind: 'month', label: '2026-07', monthly: 3000000 },
  ])

  it('обычный месяц плюс доля редких', () => {
    const need = needed(usual, data(), '2026-09', null)
    expect(need?.usual).toBe(3000000)
    expect(need?.rare).toBe(100000)
    expect(need?.rareCount).toBe(1)
    expect(need?.amount).toBe(3100000)
  })

  // Цель «откладывать 20%» значит, что расход — это 80% дохода.
  it('цель делит нужное на (1 − цель)', () => {
    const need = needed(usual, data(), '2026-09', 0.2)
    expect(need?.amount).toBe(3875000)
  })

  it('цель в ноль ничего не меняет', () => {
    expect(needed(usual, data(), '2026-09', 0)?.amount).toBe(3100000)
  })

  it('обычного месяца нет — ответа нет, а не ноль', () => {
    expect(needed(null, data(), '2026-09', 0.2)).toBeNull()
  })

  it('нет курса для ожидаемой суммы — доля не выдумывается, а называется', () => {
    const foreign = data({ recurring: [template({ expected: { amount: 10000, currency: 'USD' } })] })
    const need = needed(usual, foreign, '2026-09', null)
    expect(need?.rareCount).toBe(0)
    expect(need?.missing.map((each) => each.currency)).toEqual(['USD'])
    expect(need?.amount).toBe(3000000)
  })

  it('курс есть — доля считается по нему', () => {
    const rate: Rate = { id: 'r1', updatedAt: AT, date: '2026-09-01', from: 'USD', to: 'RUB', rate: 90, source: 'manual' }
    const foreign = data({
      recurring: [template({ expected: { amount: 12000, currency: 'USD' } })],
      rates: [rate],
    })
    const need = needed(usual, foreign, '2026-09', null)
    expect(need?.rareCount).toBe(1)
    expect(need?.rare).toBe(90000)
  })

  it('редких шаблонов нет — про невычищенные периоды не говорится', () => {
    const none = data({ recurring: [] })
    expect(needed(usual, none, '2026-09', null, 6)?.uncleanedPeriods).toBe(0)
  })

  it('редкие есть и история из периодов — число названо', () => {
    expect(needed(usual, data(), '2026-09', null, 6)?.uncleanedPeriods).toBe(6)
  })
})

describe('платежи по редким шаблонам выносятся из обычного месяца (Р-27)', () => {
  const base: MonthData = { entries: [], currencies: [RUB], rates: [], base: 'RUB' }

  // Страховка, уплаченная внутри окна, сидела бы в среднем и прибавлялась
  // сверху долей — один платёж посчитан дважды.
  it('платёж по годовому шаблону в среднее не идёт', () => {
    const entries = [
      entry({ kind: 'expense', amount: 300000, date: '2026-07-10' }),
      entry({ kind: 'expense', amount: 300000, date: '2026-08-10' }),
      entry({ kind: 'expense', amount: 1200000, date: '2026-08-15', recurringId: 'r-osago' }),
    ]
    const withAll = observations({ ...base, entries }, '2026-09')
    const without = observations({ ...base, entries }, '2026-09', { without: new Set(['r-osago']) })

    expect(usualMonth(withAll.list)?.monthly).toBe(900000)
    expect(usualMonth(without.list)?.monthly).toBe(300000)
    expect(without.excluded).toBe(1)
  })

  it('ежемесячные шаблоны из среднего не выносятся', () => {
    const entries = [entry({ kind: 'expense', amount: 300000, date: '2026-08-10', recurringId: 'r-phone' })]
    const seen = observations({ ...base, entries }, '2026-09', { without: new Set(['r-osago']) })
    expect(usualMonth(seen.list)?.monthly).toBe(300000)
    expect(seen.excluded).toBe(0)
  })

  it('итоги прежней таблицы вычистить нечем, и их число известно', () => {
    const entries = [entry({ kind: 'expense', amount: 6000000, period: { from: '2026-01-05', to: '2026-02-14' } })]
    const seen = observations({ ...base, entries }, '2026-09', { without: new Set(['r-osago']) })
    expect(seen.periodsUncleaned).toBe(1)
  })

  it('редких шаблонов нет — и невычищенных периодов нет', () => {
    const entries = [entry({ kind: 'expense', amount: 6000000, period: { from: '2026-01-05', to: '2026-02-14' } })]
    expect(observations({ ...base, entries }, '2026-09').periodsUncleaned).toBe(0)
  })

  it('id редких шаблонов берутся из справочника', () => {
    expect([...rareIds(data(), '2026-09')]).toEqual(['r-osago'])
  })
})
