import { describe, expect, it } from 'vitest'
import type { Currency, Entry, Rate } from '../../app/model.ts'
import {
  DAYS_IN_MONTH,
  monthlyExpenses,
  monthReport,
  monthShare,
  observations,
  overUsual,
  OVER_USUAL_MIN,
  perMonth,
  savingsRate,
  SAVINGS_TIMES_LIMIT,
  toDate,
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

  it('отложенное по такому месяцу не считается — и сказано почему', () => {
    const withIncome = [...covered, entry({ kind: 'income', amount: 20000000, date: '2026-09-05' })]
    const report = monthReport(data(withIncome), '2026-09')
    expect(report.saved).toBeNull()
    expect(report.savedProblem).toBe('covered')
    expect(report.savingsRate).toBeNull()
  })

  it('иначе отложенным оказался бы весь доход — число уверенное и неверное', () => {
    // Тот же доход в месяце без итогов периода считается как обычно.
    const clean = [entry({ kind: 'income', amount: 20000000, date: '2026-09-05' })]
    const report = monthReport(data(clean), '2026-09')
    expect(report.saved).toBe(20000000)
    expect(report.savedProblem).toBeNull()
  })

  it('причина различается: нет дохода — это не то же, что расход записан периодом', () => {
    const noIncome = [entry({ kind: 'expense', amount: 100000, date: '2026-09-10' })]
    expect(monthReport(data(noIncome), '2026-09').savedProblem).toBe('no-income')
  })

  it('итог периода по доходу расход месяца не прячет', () => {
    const incomeTotal = [
      entry({ kind: 'income', amount: 500000, period: { from: '2026-08-20', to: '2026-09-25' } }),
      entry({ kind: 'income', amount: 20000000, date: '2026-09-05' }),
      entry({ kind: 'expense', amount: 100000, date: '2026-09-10' }),
    ]
    const report = monthReport(data(incomeTotal), '2026-09')
    expect(report.savedProblem).toBeNull()
    expect(report.saved).toBe(19900000)
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

  // Прежний фильтр брал периоды, кончившиеся строго раньше первого числа,
  // и выбрасывал период, кончающийся ровно первым, — то есть самый свежий
  // период прежней таблицы.
  it('период, кончающийся первым числом месяца, наблюдением остаётся', () => {
    const edge = [entry({ kind: 'expense', amount: 10000000, period: { from: '2026-08-02', to: '2026-09-01' } })]
    const { list } = observations(data(edge), '2026-09')
    expect(list.map((each) => each.kind)).toEqual(['period'])
  })

  // Одни и те же деньги двумя наблюдениями: неполный месяц выписки тянет
  // среднее вниз, а период, который его накрывает, стоит рядом целым (Р-20).
  it('месяц, которым владеет период, вторым наблюдением не становится', () => {
    const both = [
      entry({ kind: 'expense', amount: 10000000, period: { from: '2026-08-02', to: '2026-09-01' } }),
      entry({ kind: 'expense', amount: 4000000, date: '2026-08-18' }),
      entry({ kind: 'expense', amount: 1000000, date: '2026-08-25' }),
    ]
    const usual = usualMonth(observations(data(both), '2026-09').list)
    expect(usual?.months).toBe(0)
    expect(usual?.periods).toBe(1)
  })

  it('период, задевший месяц краем, наблюдение у него не отнимает', () => {
    const edge = [
      entry({ kind: 'expense', amount: 10000000, period: { from: '2026-07-02', to: '2026-08-02' } }),
      entry({ kind: 'expense', amount: 3000000, date: '2026-08-18' }),
    ]
    const usual = usualMonth(observations(data(edge), '2026-09').list)
    expect(usual?.months).toBe(1)
    expect(usual?.periods).toBe(1)
  })

  it('период, владеющий самим этим месяцем, его наблюдением не становится', () => {
    const now = [entry({ kind: 'expense', amount: 10000000, period: { from: '2026-08-25', to: '2026-09-25' } })]
    expect(observations(data(now), '2026-09').list).toHaveLength(0)
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
  it('месяц, которым владеет период, прошлым месяцем не считается: категорий у периода нет', () => {
    const covered = [
      entry({ kind: 'expense', amount: 10000000, period: { from: '2026-08-02', to: '2026-09-01' } }),
      entry({ kind: 'expense', amount: 5600000, date: '2026-08-18', categoryId: 'tech' }),
      entry({ kind: 'expense', amount: 300000, date: '2026-09-05', categoryId: 'food' }),
    ]
    expect(overUsual(data(covered), '2026-09').months).toBe(0)
  })

  // Три прошлых месяца — порог `OVER_USUAL_MIN`. «Еда» и «Транспорт» есть
  // во всех трёх, «Техника» — только в одном: разовая трата.
  const list = [
    entry({ kind: 'expense', amount: 100000, date: '2026-06-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 100000, date: '2026-07-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 100000, date: '2026-08-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 50000, date: '2026-06-11', categoryId: 'ride' }),
    entry({ kind: 'expense', amount: 50000, date: '2026-07-11', categoryId: 'ride' }),
    entry({ kind: 'expense', amount: 50000, date: '2026-08-11', categoryId: 'ride' }),
    entry({ kind: 'expense', amount: 5625000, date: '2026-06-20', categoryId: 'tech' }),
    entry({ kind: 'expense', amount: 400000, date: '2026-09-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 50000, date: '2026-09-11', categoryId: 'ride' }),
  ]

  it('наибольшее отклонение — первым, и оно знает своё основание', () => {
    const report = overUsual(data(list), '2026-09')
    expect(report.over[0]?.categoryId).toBe('food')
    expect(report.over[0]?.now).toBe(400000)
    expect(report.over[0]?.usual).toBe(100000)
    expect(report.over[0]?.delta).toBe(300000)
    expect(report.over[0]?.months).toBe(3)
    expect(report.over[0]?.seen).toBe(3)
  })

  it('категория, совпавшая с обычной, в список не идёт', () => {
    expect(overUsual(data(list), '2026-09').over.some((each) => each.categoryId === 'ride')).toBe(false)
  })

  // Разовая трата, размазанная по прошлым месяцам, даёт верную арифметику
  // без смысла: «обычно 18 750» — о трате, которой обычно нет вовсе (Р-21).
  it('категория, встречавшаяся реже половины месяцев, отклонением не становится', () => {
    const report = overUsual(data(list), '2026-09')
    expect(report.over.some((each) => each.categoryId === 'tech')).toBe(false)
    expect(report.rare).toBe(1)
  })

  it('появившееся впервые не прячется, но и «обычно 0» не выдумывает', () => {
    const fresh = [...list, entry({ kind: 'expense', amount: 2000000, date: '2026-09-12', categoryId: 'vet' })]
    const report = overUsual(data(fresh), '2026-09')
    expect(report.fresh).toEqual([{ categoryId: 'vet', now: 2000000 }])
    expect(report.over.some((each) => each.categoryId === 'vet')).toBe(false)
  })

  it('прошлых месяцев меньше порога — блок молчит и называет, сколько их', () => {
    expect(OVER_USUAL_MIN).toBe(3)
    const thin = list.filter((each) => !each.date?.startsWith('2026-06'))
    const report = overUsual(data(thin), '2026-09')
    expect(report.months).toBe(2)
    expect(report.over).toEqual([])
    expect(report.fresh).toEqual([])
  })

  it('прошлого нет — сравнивать не с чем', () => {
    const only = list.filter((each) => each.date?.startsWith('2026-09'))
    expect(overUsual(data(only), '2026-09').months).toBe(0)
  })

  it('расход без категории не прячется', () => {
    const noCategory = [
      entry({ kind: 'expense', amount: 100000, date: '2026-06-10' }),
      entry({ kind: 'expense', amount: 100000, date: '2026-07-10' }),
      entry({ kind: 'expense', amount: 100000, date: '2026-08-10' }),
      entry({ kind: 'expense', amount: 900000, date: '2026-09-10' }),
    ]
    const report = overUsual(data(noCategory), '2026-09')
    expect(report.over[0]?.categoryId).toBeNull()
    expect(report.over[0]?.delta).toBe(800000)
  })
})

describe('норма сбережений читается (Р-23)', () => {
  function report(income: number, expense: number) {
    return monthReport(
      data([
        entry({ kind: 'income', amount: income, date: '2026-09-05' }),
        entry({ kind: 'expense', amount: expense, date: '2026-09-10' }),
      ]),
      '2026-09',
    )
  }

  it('обычный месяц называется долей дохода', () => {
    expect(savingsRate(report(10000000, 8000000))).toEqual({ kind: 'share', share: 0.2 })
  })

  it('расход больше дохода, но в пределах — всё ещё доля', () => {
    expect(SAVINGS_TIMES_LIMIT).toBe(2)
    expect(savingsRate(report(10000000, 20000000))).toEqual({ kind: 'share', share: -1 })
  })

  // «−1016% дохода» — число честное и нечитаемое: доля от неполного дохода
  // говорит о данных, а не о человеке.
  it('расход больше дохода в разы — кратность и сумма вместо сотен процентов', () => {
    const rate = savingsRate(report(1000000, 11000000))
    expect(rate.kind).toBe('times')
    if (rate.kind !== 'times') throw new Error('ожидалась кратность')
    expect(Math.round(rate.times)).toBe(11)
    expect(rate.short).toBe(10000000)
  })

  it('дохода нет — доли нет, и это не ноль', () => {
    const none = monthReport(data([entry({ kind: 'expense', amount: 500000, date: '2026-09-10' })]), '2026-09')
    expect(savingsRate(none)).toEqual({ kind: 'none' })
  })
})

describe('месяц, который ещё идёт (Р-22)', () => {
  it('прошедший месяц считается полным: сравнивать его можно целиком', () => {
    expect(monthShare('2026-08', '2026-09-22')).toBeNull()
  })

  it('текущий месяц знает, сколько его дней прошло', () => {
    expect(monthShare('2026-09', '2026-09-22')).toEqual({ passed: 22, total: 30 })
  })

  it('месяц, который ещё не начался, прожитых дней не имеет', () => {
    expect(monthShare('2026-10', '2026-09-22')).toEqual({ passed: 0, total: 31 })
  })

  it('обычное урезается до прожитого срока, а не достраивается до месяца', () => {
    expect(toDate(3000000, { passed: 15, total: 30 })).toBe(1500000)
    expect(toDate(3000000, null)).toBe(3000000)
  })

  // Двадцатого числа любая категория «ниже обычного», и список отклонений
  // говорит о календаре, а не о тратах.
  it('отклонение по категории считается от урезанного обычного', () => {
    const list = [
      entry({ kind: 'expense', amount: 3000000, date: '2026-06-10', categoryId: 'food' }),
      entry({ kind: 'expense', amount: 3000000, date: '2026-07-10', categoryId: 'food' }),
      entry({ kind: 'expense', amount: 3000000, date: '2026-08-10', categoryId: 'food' }),
      entry({ kind: 'expense', amount: 1500000, date: '2026-09-05', categoryId: 'food' }),
    ]
    const whole = overUsual(data(list), '2026-09')
    expect(whole.over[0]?.usual).toBe(3000000)
    expect(whole.over[0]?.delta).toBe(-1500000)

    // Полмесяца прошло — обычное к этому дню тоже половина, и трата ровно
    // в обычном темпе отклонением не считается вовсе.
    const half = overUsual(data(list), '2026-09', { today: '2026-09-15' })
    expect(half.running).toEqual({ passed: 15, total: 30 })
    expect(half.over).toEqual([])
  })

  it('отчёт месяца говорит, идёт ли месяц, только когда его спросили о дне', () => {
    const list = [entry({ kind: 'expense', amount: 100000, date: '2026-09-05' })]
    expect(monthReport(data(list), '2026-09').running).toBeNull()
    expect(monthReport(data(list), '2026-09', '2026-09-22').running).toEqual({ passed: 22, total: 30 })
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

describe('период владеет месяцем по большинству дней (Р-20)', () => {
  const edge = [
    // Последний период прежней таблицы кончается первым сентября:
    // в сентябрь он заходит одним днём из тридцати.
    entry({ kind: 'expense', amount: 4155900, period: { from: '2026-08-01', to: '2026-09-01' } }),
    entry({ kind: 'expense', amount: 4409016, date: '2026-09-10', categoryId: 'food' }),
    entry({ kind: 'income', amount: 395200, date: '2026-09-02' }),
  ]

  it('край периода месяц не забирает: отложенное считается', () => {
    const report = monthReport(data(edge), '2026-09')
    expect(report.savedProblem).toBeNull()
    expect(report.saved).toBe(395200 - 4409016)
  })

  it('и сколько дней всё-таки задето — названо числом', () => {
    const report = monthReport(data(edge), '2026-09')
    expect(report.coveredDays).toBe(1)
    expect(report.monthDays).toBe(30)
  })

  it('август тот же период забирает целиком', () => {
    const report = monthReport(data(edge), '2026-08')
    expect(report.coveredDays).toBe(31)
    expect(report.savedProblem).toBe('covered')
  })

  it('ровно половина месяца — ещё не большинство', () => {
    const half = [entry({ kind: 'expense', amount: 100, period: { from: '2026-09-01', to: '2026-09-15' } })]
    expect(monthReport(data(half), '2026-09').coveredDays).toBe(15)
    expect(monthReport(data(half), '2026-09').savedProblem).not.toBe('covered')
  })

  it('на день больше половины — уже большинство', () => {
    const most = [entry({ kind: 'expense', amount: 100, period: { from: '2026-09-01', to: '2026-09-16' } })]
    expect(monthReport(data(most), '2026-09').savedProblem).toBe('covered')
  })

  it('два периода, задевающие одни и те же дни, дважды их не считают', () => {
    const both = [
      entry({ kind: 'expense', amount: 100, period: { from: '2026-09-01', to: '2026-09-10' } }),
      entry({ kind: 'expense', amount: 200, period: { from: '2026-09-01', to: '2026-09-10' }, special: true }),
    ]
    expect(monthReport(data(both), '2026-09').coveredDays).toBe(10)
  })

  it('итог по доходу расход месяца не прячет', () => {
    const income = [entry({ kind: 'income', amount: 100, period: { from: '2026-09-01', to: '2026-09-30' } })]
    expect(monthReport(data(income), '2026-09').coveredDays).toBe(0)
  })
})
