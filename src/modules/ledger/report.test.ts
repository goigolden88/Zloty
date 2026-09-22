import { describe, expect, it } from 'vitest'
import type { Currency, Entry } from '../../app/model.ts'
import { monthReport, observations, overUsual, usualMonth, type MonthData } from './month.ts'
import { monthReportText, REPORT_PROMPT, type ReportInput } from './report.ts'

/** Суммы, счета и категории выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
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

function input(entries: Entry[], over: Partial<ReportInput> = {}): ReportInput {
  const data: MonthData = { entries, currencies: [RUB], rates: [], base: 'RUB' }
  const seen = observations(data, '2026-09')
  return {
    month: '2026-09',
    base: 'RUB',
    currencies: [RUB],
    report: monthReport(data, '2026-09'),
    usual: usualMonth(seen.list, seen.missing),
    need: null,
    growth: null,
    categories: { rows: [], months: 0 },
    over: overUsual(data, '2026-09'),
    recorded: null,
    excluded: 0,
    due: [],
    names: new Map([['food', 'Еда']]),
    ...over,
  }
}

/** Деньги форматируются с неразрывными пробелами — сравниваем без них. */
function flat(text: string): string {
  return text.replace(/\u00a0|\u202f/g, ' ')
}

describe('отчёт месяца (Р-29)', () => {
  const list = [
    entry({ kind: 'income', amount: 10000000, date: '2026-09-05', categoryId: 'pay' }),
    entry({ kind: 'expense', amount: 300000, date: '2026-09-10', categoryId: 'food' }),
    entry({ kind: 'expense', amount: 900000, date: '2026-09-12', categoryId: 'tech', special: true }),
  ]

  it('называет месяц и числа с основанием', () => {
    const text = flat(monthReportText(input(list)))
    expect(text).toContain('# Деньги за сентябрь 2026')
    expect(text).toContain('по 1 операции')
    expect(text).toContain('обычный 3 000,00 ₽')
    expect(text).toContain('особый 9 000,00 ₽')
  })

  it('доход не внесён — сказано словами, а не нулём', () => {
    const text = monthReportText(input(list.filter((each) => each.kind !== 'income')))
    expect(text).toContain('Доход: не внесён')
    expect(text).toContain('Доход за месяц не внесён вовсе')
  })

  // Беседа экрана не видит: без этого раздела она объяснит дыры в данных
  // привычками человека — уверенно и неверно.
  it('расход, записанный итогом за период, назван в «чего приложение не знает»', () => {
    const covered = [entry({ kind: 'expense', amount: 4000000, period: { from: '2026-09-01', to: '2026-09-30' } })]
    const text = monthReportText(input(covered))
    expect(text).toContain('## Чего приложение не знает')
    expect(text).toContain('записаны итогом за период')
    expect(text).toContain('по категориям не разложено')
  })

  it('незагруженные дни названы отдельно от прожитых', () => {
    const data: MonthData = { entries: list, currencies: [RUB], rates: [], base: 'RUB' }
    const text = monthReportText(
      input(list, {
        report: monthReport(data, '2026-09', '2026-09-22', '2026-09-18'),
        recorded: {
          day: '2026-09-18',
          account: { id: 'a1', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0 },
        },
      }),
    )
    expect(text).toContain('Месяц ещё идёт: прошло 22 из 30')
    expect(text).toContain('по счёту «Синий банк»')
    expect(text).toContain('Расход за последние 4 дня неизвестен')
  })

  it('вопрос стоит в конце, после чисел', () => {
    const text = monthReportText(input(list))
    expect(text).toContain('## Вопрос')
    expect(text.indexOf('## Вопрос')).toBeGreaterThan(text.indexOf('## Итоги месяца'))
    expect(text).toContain(REPORT_PROMPT)
  })

  it('вопрос просит беседу сомневаться в числах, а не только советовать', () => {
    expect(REPORT_PROMPT).toContain('В чём ты сомневаешься')
    expect(REPORT_PROMPT).toContain('Чего приложение не знает')
  })

  it('норма сбережений в отчёте читается так же, как на экране', () => {
    const thin = [
      entry({ kind: 'income', amount: 100000, date: '2026-09-05', categoryId: 'pay' }),
      entry({ kind: 'expense', amount: 1100000, date: '2026-09-10', categoryId: 'food' }),
    ]
    const text = flat(monthReportText(input(thin)))
    expect(text).toContain('расход больше дохода в 11 раз')
    expect(text).not.toContain('−1000%')
  })

  it('регулярные названы вместе с тем, внесены они или нет', () => {
    const text = flat(
      monthReportText(
        input(list, {
          due: [
            {
              recurring: {
                id: 'r1',
                updatedAt: AT,
                name: 'Связь',
                categoryId: 'food',
                expected: { amount: 51500, currency: 'RUB' },
                every: { months: 1 },
                from: '2026-01',
                order: 0,
              },
              entries: [],
              paid: 0,
            },
          ],
        }),
      ),
    )
    expect(text).toContain('- Связь: ждали 515,00 ₽, не внесено')
  })
})
