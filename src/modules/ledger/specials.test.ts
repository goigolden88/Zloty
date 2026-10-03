import { describe, expect, it } from 'vitest'
import type { Currency, Entry, SpecialPeriod } from '../../app/model.ts'
import { monthReport, monthSpecials, observations, overUsual, usualMonth, type MonthData } from './month.ts'
import { monthReportText } from './report.ts'
import {
  createSpecial,
  isSpecial,
  liveSpecials,
  SPECIAL_UNTITLED,
  specialPeriodOf,
  specialProblem,
  specialTitle,
  updateSpecial,
} from './specials.ts'

/** Суммы, даты и названия выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'
const RUB: Currency = { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }

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

function period(id: string, from: string, to: string, title?: string): SpecialPeriod {
  return { id, updatedAt: AT, from, to, ...(title === undefined ? {} : { title }) }
}

function data(entries: Entry[], specials: SpecialPeriod[] = []): MonthData {
  return { entries, currencies: [RUB], rates: [], base: 'RUB', specials }
}

/** Деньги форматируются с неразрывными пробелами — сравниваем без них. */
function flat(text: string): string {
  return text.replace(/ | /g, ' ')
}

const TRIP = period('p-trip', '2026-09-10', '2026-09-14', 'Поездка на море')

describe('особая ли трата: флаг или период (Р-55)', () => {
  it('расход с датой внутри периода — особый, флага в записи нет', () => {
    const spent = entry({ kind: 'expense', amount: 500000, date: '2026-09-12' })
    expect(isSpecial(spent, [TRIP])).toBe(true)
    expect(specialPeriodOf(spent, [TRIP])).toBe(TRIP)
    expect(spent.special).toBeUndefined()
  })

  it('границы периода включительно', () => {
    expect(isSpecial(entry({ kind: 'expense', amount: 1, date: '2026-09-10' }), [TRIP])).toBe(true)
    expect(isSpecial(entry({ kind: 'expense', amount: 1, date: '2026-09-14' }), [TRIP])).toBe(true)
    expect(isSpecial(entry({ kind: 'expense', amount: 1, date: '2026-09-09' }), [TRIP])).toBe(false)
    expect(isSpecial(entry({ kind: 'expense', amount: 1, date: '2026-09-15' }), [TRIP])).toBe(false)
  })

  it('регулярная в дни периода — обычная: аренда в месяц поездки не выброс', () => {
    const rent = entry({ kind: 'expense', amount: 3000000, date: '2026-09-12', recurringId: 'rent' })
    expect(isSpecial(rent, [TRIP])).toBe(false)
  })

  it('итог периода по периоду особым не становится', () => {
    const total = entry({ kind: 'expense', amount: 4000000, period: { from: '2026-09-01', to: '2026-09-30' } })
    expect(isSpecial(total, [TRIP])).toBe(false)
  })

  it('доход и перевод — нет: для доходов пока ничего', () => {
    expect(isSpecial(entry({ kind: 'income', amount: 1, date: '2026-09-12' }), [TRIP])).toBe(false)
    expect(isSpecial(entry({ kind: 'transfer', amount: 1, date: '2026-09-12' }), [TRIP])).toBe(false)
  })

  it('флаг работает как прежде — и вне периодов, и у итога периода, и у регулярной', () => {
    expect(isSpecial(entry({ kind: 'expense', amount: 1, date: '2026-08-01', special: true }), [TRIP])).toBe(true)
    expect(isSpecial(entry({ kind: 'expense', amount: 1, date: '2026-08-01', special: true }))).toBe(true)
    const total = entry({ kind: 'expense', amount: 1, period: { from: '2026-09-01', to: '2026-09-30' }, special: true })
    expect(isSpecial(total, [TRIP])).toBe(true)
    const flagged = entry({ kind: 'expense', amount: 1, date: '2026-09-12', recurringId: 'rent', special: true })
    expect(isSpecial(flagged, [TRIP])).toBe(true)
  })

  it('удалённый период трату не делает особой — траты снова обычные', () => {
    const spent = entry({ kind: 'expense', amount: 500000, date: '2026-09-12' })
    expect(isSpecial(spent, [{ ...TRIP, deleted: true }])).toBe(false)
  })
})

describe('расход месяца с особым периодом', () => {
  const list = [
    entry({ kind: 'income', amount: 20000000, date: '2026-09-05' }),
    entry({ kind: 'expense', amount: 300000, date: '2026-09-03', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 700000, date: '2026-09-11', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 1100000, date: '2026-09-13', categoryId: 'hotel' }),
    entry({ kind: 'expense', amount: 3000000, date: '2026-09-12', categoryId: 'home', recurringId: 'rent' }),
  ]

  it('трата периода — в особом расходе месяца, не в обычном; регулярная — в обычном', () => {
    const report = monthReport(data(list, [TRIP]), '2026-09')
    expect(report.expense.amount).toBe(5100000)
    expect(report.specialExpense.amount).toBe(1800000)
    expect(report.specialExpense.entries).toBe(2)
    expect(report.usualExpense.amount).toBe(3300000)
    expect(report.spanExpense.amount).toBe(3300000)
  })

  it('удалили период — траты снова обычные', () => {
    const report = monthReport(data(list, [{ ...TRIP, deleted: true }]), '2026-09')
    expect(report.specialExpense.amount).toBe(0)
    expect(report.usualExpense.amount).toBe(5100000)
  })

  it('в отчёте для беседы траты периода — особые', () => {
    const shown = data(list, [TRIP])
    const seen = observations(shown, '2026-09')
    const text = flat(
      monthReportText({
        month: '2026-09',
        base: 'RUB',
        currencies: [RUB],
        report: monthReport(shown, '2026-09'),
        usual: usualMonth(seen.list, seen.missing),
        need: null,
        growth: null,
        categories: { rows: [], months: 0 },
        over: overUsual(shown, '2026-09'),
        recorded: null,
        excluded: 0,
        due: [],
        names: new Map(),
      }),
    )
    expect(text).toContain('обычный 33 000,00 ₽, особый 18 000,00 ₽')
  })
})

describe('обычный месяц и «вышло за обычное» без трат периода', () => {
  // Шесть прошлых месяцев по 10 000 ₽ на еду; в августе — поездка.
  const past = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((month) =>
    entry({ kind: 'expense', amount: 1000000, date: `${month}-05`, categoryId: 'food' }),
  )
  const trip = period('p-aug', '2026-08-10', '2026-08-20', 'Отпуск')
  const away = [
    entry({ kind: 'expense', amount: 6000000, date: '2026-08-12', categoryId: 'hotel' }),
    entry({ kind: 'expense', amount: 2000000, date: '2026-08-15', categoryId: 'food' }),
  ]
  const now = entry({ kind: 'expense', amount: 1000000, date: '2026-09-05', categoryId: 'food' })
  const all = [...past, ...away, now]

  it('обычный месяц не видит трат периода', () => {
    const seen = observations(data(all, [trip]), '2026-09')
    const usual = usualMonth(seen.list, seen.missing)
    expect(usual?.monthly).toBe(1000000)
    expect(usual?.months).toBe(6)
  })

  it('без периода те же траты поднимают обычный месяц', () => {
    const seen = observations(data(all), '2026-09')
    expect(usualMonth(seen.list, seen.missing)?.monthly).toBeGreaterThan(1000000)
  })

  it('«вышло за обычное» не считает трат периода ни в прошлом, ни в этом месяце', () => {
    const over = overUsual(data(all, [trip]), '2026-09')
    expect(over.over).toEqual([])
    expect(over.fresh).toEqual([])

    const inSeptember = period('p-sep', '2026-09-01', '2026-09-30')
    const extra = entry({ kind: 'expense', amount: 9000000, date: '2026-09-07', categoryId: 'tech' })
    const later = overUsual(data([...all, extra], [trip, inSeptember]), '2026-09')
    expect(later.fresh).toEqual([])
  })
})

describe('особый расход месяца по периодам — для экрана (Р-55)', () => {
  const spring = period('p-1', '2026-08-28', '2026-09-03', 'Поездка в горы')
  const autumn = period('p-2', '2026-09-20', '2026-09-22')
  const list = [
    entry({ kind: 'expense', amount: 400000, date: '2026-08-29' }),
    entry({ kind: 'expense', amount: 100000, date: '2026-09-01' }),
    entry({ kind: 'expense', amount: 200000, date: '2026-09-03', special: true }),
    entry({ kind: 'expense', amount: 300000, date: '2026-09-02', recurringId: 'rent' }),
    entry({ kind: 'expense', amount: 900000, date: '2026-09-15', special: true }),
    entry({ kind: 'expense', amount: 50000, date: '2026-09-16' }),
    entry({ kind: 'income', amount: 5000000, date: '2026-09-02' }),
  ]

  it('каждый период, задевший месяц, — с суммой и числом его трат в этом месяце', () => {
    const result = monthSpecials(data(list, [autumn, spring]), '2026-09')
    expect(result.periods.map((each) => each.period.id)).toEqual(['p-1', 'p-2'])
    expect(result.periods[0]?.sum.amount).toBe(300000)
    expect(result.periods[0]?.sum.entries).toBe(2)
    expect(result.periods[1]?.sum.amount).toBe(0)
    expect(result.periods[1]?.sum.entries).toBe(0)
  })

  it('особые по флагу вне периодов — отдельно', () => {
    const result = monthSpecials(data(list, [spring, autumn]), '2026-09')
    expect(result.outside.amount).toBe(900000)
    expect(result.outside.entries).toBe(1)
  })

  it('период через границу месяцев — у каждого месяца своя часть', () => {
    const august = monthSpecials(data(list, [spring]), '2026-08')
    expect(august.periods).toHaveLength(1)
    expect(august.periods[0]?.sum.amount).toBe(400000)
    expect(august.periods[0]?.sum.entries).toBe(1)
  })

  it('части вместе дают особый расход месяца', () => {
    const shown = data(list, [spring, autumn])
    const result = monthSpecials(shown, '2026-09')
    const parts = result.periods.reduce((sum, each) => sum + each.sum.amount, 0) + result.outside.amount
    expect(parts).toBe(monthReport(shown, '2026-09').specialExpense.amount)
  })

  it('удалённый период и период другого месяца не показываются', () => {
    const october = period('p-3', '2026-10-01', '2026-10-05')
    const result = monthSpecials(data(list, [{ ...spring, deleted: true }, october]), '2026-09')
    expect(result.periods).toEqual([])
    // Без периода трата с флагом — снова «вне периодов».
    expect(result.outside.amount).toBe(1100000)
  })
})

describe('правила периода', () => {
  it('последний день не раньше первого; один день — законно', () => {
    expect(specialProblem({ from: '2026-09-10', to: '2026-09-09' }, [])).toBe('последний день раньше первого')
    expect(specialProblem({ from: '2026-09-10', to: '2026-09-10' }, [])).toBeNull()
  })

  it('без дат период не записывается', () => {
    expect(specialProblem({ from: '', to: '2026-09-10' }, [])).toBe('у периода нет первого дня')
    expect(specialProblem({ from: '2026-09-10', to: '10.09.2026' }, [])).toBe('у периода нет последнего дня')
  })

  it('период, задевающий другой, не записывается, и задетый назван', () => {
    const problem = specialProblem({ from: '2026-09-14', to: '2026-09-18' }, [TRIP])
    expect(problem).toContain('«Поездка на море» 10.09.2026 — 14.09.2026')
    expect(specialProblem({ from: '2026-09-01', to: '2026-09-30' }, [TRIP])).not.toBeNull()
    expect(specialProblem({ from: '2026-09-11', to: '2026-09-12' }, [TRIP])).not.toBeNull()
  })

  it('соседний день — не пересечение', () => {
    expect(specialProblem({ from: '2026-09-15', to: '2026-09-18' }, [TRIP])).toBeNull()
    expect(specialProblem({ from: '2026-09-01', to: '2026-09-09' }, [TRIP])).toBeNull()
  })

  it('правка периода с самим собой не сравнивает; удалённый не мешает', () => {
    expect(specialProblem({ from: '2026-09-09', to: '2026-09-16' }, [TRIP], TRIP.id)).toBeNull()
    expect(specialProblem({ from: '2026-09-12', to: '2026-09-13' }, [{ ...TRIP, deleted: true }])).toBeNull()
  })

  it('период без названия называется «Особый период»', () => {
    const untitled = period('p-x', '2026-09-01', '2026-09-02')
    expect(specialTitle(untitled)).toBe(SPECIAL_UNTITLED)
    expect(specialProblem({ from: '2026-09-02', to: '2026-09-03' }, [untitled])).toContain(`«${SPECIAL_UNTITLED}»`)
  })

  it('живые периоды — без надгробий, от ранних к поздним', () => {
    const late = period('p-b', '2026-10-01', '2026-10-02')
    const gone = { ...period('p-c', '2026-07-01', '2026-07-02'), deleted: true }
    expect(liveSpecials([late, gone, TRIP]).map((each) => each.id)).toEqual([TRIP.id, late.id])
  })

  it('запись периода: пустое название не пишется, правка сохраняет id', () => {
    const made = createSpecial({ from: '2026-09-01', to: '2026-09-03', title: '  ' })
    expect(made.title).toBeUndefined()
    expect(made.from).toBe('2026-09-01')
    const next = updateSpecial(made, { from: '2026-09-02', to: '2026-09-04', title: ' Дача ' })
    expect(next.id).toBe(made.id)
    expect(next.title).toBe('Дача')
    expect(next.to).toBe('2026-09-04')
  })
})
