import { describe, expect, it } from 'vitest'
import type { Account, Category, Entry, Recurring } from '../../app/model.ts'
import {
  monthHasEntries,
  monthNotice,
  RECURRING_FROM_DAY,
  recurringNotice,
  REMIND_FROM_DAY,
} from './remind.ts'
import type { RecurringData } from './recurring.ts'

/** Суммы и названия выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const BANK: Account = { id: 'acc', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0 }
const LINK: Category = { id: 'cat', updatedAt: AT, name: 'Связь', side: 'expense', order: 0 }

function entry(fields: Partial<Entry> = {}): Entry {
  return {
    id: 'e',
    updatedAt: AT,
    kind: 'expense',
    accountId: BANK.id,
    money: { amount: 1000, currency: 'RUB' },
    date: '2026-08-10',
    ...fields,
  }
}

function template(fields: Partial<Recurring> = {}): Recurring {
  return {
    id: 'r',
    updatedAt: AT,
    name: 'Связь',
    categoryId: LINK.id,
    accountId: BANK.id,
    expected: { amount: 60000, currency: 'RUB' },
    every: { months: 1 },
    from: '2026-01',
    order: 0,
    ...fields,
  }
}

function data(over: Partial<RecurringData> = {}): RecurringData {
  return { recurring: [template()], categories: [LINK], accounts: [BANK], entries: [], ...over }
}

describe('«пора внести месяц»', () => {
  it('молчит, пока прошлый месяц внесён', () => {
    expect(monthNotice([entry()], '2026-09-20')).toBeNull()
  })

  it('говорит, когда за прошлый месяц нет ни одной записи', () => {
    const onlyThis = [entry({ date: '2026-09-05' })]
    expect(monthNotice(onlyThis, '2026-09-20')?.body).toContain('август')
  })

  it('молчит первого и второго числа: выписка ещё не готова', () => {
    const onlyThis = [entry({ date: '2026-09-05' })]
    expect(monthNotice(onlyThis, '2026-09-01')).toBeNull()
    expect(monthNotice(onlyThis, `2026-09-0${REMIND_FROM_DAY}`)).not.toBeNull()
  })

  it('молчит на пустой базе: новому человеку показывают приветствие', () => {
    expect(monthNotice([], '2026-09-20')).toBeNull()
    expect(monthNotice([entry({ deleted: true })], '2026-09-20')).toBeNull()
  })

  it('итог периода закрывает месяц, который он накрывает', () => {
    const total = [entry({ date: undefined, period: { from: '2026-07-20', to: '2026-09-05' } })]
    expect(monthHasEntries(total, '2026-08')).toBe(true)
    expect(monthNotice(total, '2026-09-20')).toBeNull()
  })

  it('через новый год месяц считается верно', () => {
    const onlyJanuary = [entry({ date: '2027-01-05' })]
    expect(monthNotice(onlyJanuary, '2027-01-20')?.body).toContain('декабрь')
  })
})

describe('«регулярные не внесены»', () => {
  it('говорит про те, которых ещё нет', () => {
    const notice = recurringNotice(data(), '2026-09-20')
    expect(notice?.title).toContain('Регулярная')
    expect(notice?.body).toContain('Связь')
  })

  it('молчит, когда всё внесено', () => {
    const paid = entry({ date: '2026-09-05', recurringId: 'r' })
    expect(recurringNotice(data({ entries: [paid] }), '2026-09-20')).toBeNull()
  })

  it('молчит в начале месяца: платить ещё рано', () => {
    expect(recurringNotice(data(), '2026-09-05')).toBeNull()
    expect(recurringNotice(data(), `2026-09-${RECURRING_FROM_DAY}`)).not.toBeNull()
  })

  it('молчит, когда регулярных нет вовсе', () => {
    expect(recurringNotice(data({ recurring: [] }), '2026-09-20')).toBeNull()
  })

  it('несколько невнесённых — заголовок во множественном числе, и все названы', () => {
    const two = [template(), template({ id: 'r2', name: 'Интернет', order: 1 })]
    const notice = recurringNotice(data({ recurring: two }), '2026-09-20')
    expect(notice?.title).toBe('Регулярные не внесены')
    expect(notice?.body).toContain('Связь, Интернет')
  })
})
