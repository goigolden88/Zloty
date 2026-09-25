import { describe, expect, it } from 'vitest'
import { buildSummary, checkSummary, summaryPeriods, UNKNOWN } from '../shared/core/summary.ts'
import type { Metric, PeriodSummary, Unknown } from '../shared/core/summary.ts'
import type { Account, Balance, Category, Entry, Recurring } from '../app/model.ts'
import { RECURRING_FROM_DAY, REMIND_FROM_DAY } from '../modules/ledger/remind.ts'
import { KEYS, NOT_LOADED, summary, type SliceData } from './slice.ts'

/** Счета, категории, шаблоны и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

function account(fields: Partial<Account> = {}): Account {
  return { id: 'blue', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0, ...fields }
}

const PHONE: Category = { id: 'phone', updatedAt: AT, name: 'Связь для Пети', side: 'expense', order: 0 }

const TEMPLATE: Recurring = {
  id: 'tpl',
  updatedAt: AT,
  name: 'Тариф Пети',
  categoryId: PHONE.id,
  accountId: 'blue',
  expected: { amount: 60000, currency: 'RUB' },
  every: { months: 1 },
  from: '2026-01',
  order: 0,
}

let counter = 0
function entry(fields: Partial<Entry> = {}): Entry {
  counter += 1
  return {
    id: `e${counter}`,
    updatedAt: AT,
    kind: 'expense',
    accountId: 'blue',
    money: { amount: 1000, currency: 'RUB' },
    date: '2026-09-10',
    categoryId: PHONE.id,
    note: 'обед с Петей',
    ...fields,
  }
}

function balance(date: string, fields: Partial<Balance> = {}): Balance {
  return { id: `b-${date}-${fields.part ?? ''}`, updatedAt: AT, accountId: 'blue', date, amount: 500000, ...fields }
}

function data(over: Partial<SliceData> = {}): SliceData {
  return {
    accounts: [account()],
    categories: [PHONE],
    recurring: [],
    entries: [entry()],
    balances: [],
    ...over,
  }
}

const DAY = '2026-09-25'

function period(body: ReturnType<typeof summary>, index: number): PeriodSummary {
  return body.periods[index] as PeriodSummary
}

function metric(p: PeriodSummary, key: string): Metric {
  const metrics = p.metrics as Metric[]
  const found = metrics.find((each) => each.key === key)
  if (!found) throw new Error(`нет показателя ${key}`)
  return found
}

/** Отрезки по порядку ядра: 0, 1 — недели; 2 — прошлый месяц, 3 — идущий. */
const PAST = 2
const RUNNING = 3

describe('срез итогов — отрезки', () => {
  it('ровно четыре отрезка ядра, недели — «пока не считаем»', () => {
    const body = summary(data(), DAY)
    expect(body.periods.map(({ grain, from, to }) => ({ grain, from, to }))).toEqual(summaryPeriods(DAY))
    for (const index of [0, 1]) {
      expect((period(body, index).metrics as Unknown).unknown).toBe(UNKNOWN.notProvided)
    }
    // Прошлая неделя закончилась, идущая — нет.
    expect(period(body, 0).through).toBeNull()
    expect(period(body, 1).through).toBe(DAY)
  })

  it('месяц календарный, даже если в профиле указан другой первый день', () => {
    // periodStartDay не читает ни один расчёт (Р-50, п. 4) — срез тоже.
    const body = summary(data(), DAY)
    expect(period(body, RUNNING)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' })
    expect(period(body, PAST)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('у каждого месяца три показателя с постоянными ключами', () => {
    const body = summary(data(), DAY)
    for (const index of [PAST, RUNNING]) {
      expect((period(body, index).metrics as Metric[]).map((each) => each.key)).toEqual([
        KEYS.records,
        KEYS.waiting,
        KEYS.snapshots,
      ])
    }
  })
})

describe('срез итогов — по какое число верен месяц (Р-26, Р-50)', () => {
  it('идущий — по отставшую сильнее всех выписку; счёт истории и архив не в счёт', () => {
    const accounts = [
      account({ id: 'a', loadedThrough: '2026-09-22' }),
      account({ id: 'b', loadedThrough: '2026-09-20' }),
      account({ id: 'history', ledgerOnly: true, loadedThrough: '2026-01-31' }),
      account({ id: 'old', archived: true, loadedThrough: '2026-03-31' }),
    ]
    const body = summary(data({ accounts }), DAY)
    expect(period(body, RUNNING).through).toBe('2026-09-20')
    expect(metric(period(body, RUNNING), KEYS.records).basis).toContain('выписки доведены по 20.09.2026')
    expect(period(body, PAST).through).toBeNull()
  })

  it('идущий — не позже дня расчёта', () => {
    const body = summary(data({ accounts: [account({ loadedThrough: '2026-09-30' })] }), DAY)
    expect(period(body, RUNNING).through).toBe(DAY)
  })

  it('выписок со сверкой нет — идущий по день расчёта, прошлый закончен', () => {
    const body = summary(data(), DAY)
    expect(period(body, RUNNING).through).toBe(DAY)
    expect(period(body, PAST).through).toBeNull()
    expect(metric(period(body, RUNNING), KEYS.records).basis).toContain('выписок со сверкой нет')
  })

  it('прошлый месяц, доведённый не до конца, — по отметку', () => {
    const day = '2026-10-05'
    const body = summary(data({ accounts: [account({ loadedThrough: '2026-09-18' })] }), day)
    expect(period(body, PAST).through).toBe('2026-09-18')
    expect(metric(period(body, PAST), KEYS.records).value).toEqual({ n: 1, unit: 'count' })
  })

  it('выписки не дошли до месяца — записи «не известно», а не ноль; остальное числами', () => {
    const day = '2026-10-05'
    const body = summary(data({ accounts: [account({ loadedThrough: '2026-09-18' })] }), day)
    const running = period(body, RUNNING)
    const records = metric(running, KEYS.records).value as Unknown
    expect(records.unknown).toBe(NOT_LOADED)
    expect(records.text).toContain('18.09.2026')
    expect(running.through).toBe(day)
    expect(metric(running, KEYS.waiting).value).toMatchObject({ unit: 'count' })
    expect(metric(running, KEYS.snapshots).value).toMatchObject({ unit: 'count' })
  })

  it('не дошли и до прошлого месяца — он закончен, записи «не известно»', () => {
    const body = summary(data({ accounts: [account({ loadedThrough: '2026-08-20' })] }), '2026-10-05')
    expect(period(body, PAST).through).toBeNull()
    expect((metric(period(body, PAST), KEYS.records).value as Unknown).unknown).toBe(NOT_LOADED)
  })
})

describe('срез итогов — показатели', () => {
  it('ноль записей — тоже строка, а не пропуск', () => {
    const body = summary(data({ entries: [entry({ date: '2026-07-01' })] }), DAY)
    const records = metric(period(body, RUNNING), KEYS.records)
    expect(records.value).toEqual({ n: 0, unit: 'count' })
    expect(records.basis).toContain('записей нет')
  })

  it('записи — операции и итоги периода, основание называет тех и других', () => {
    const entries = [
      entry({ date: '2026-08-03' }),
      entry({ date: '2026-08-04' }),
      entry({ date: undefined, period: { from: '2026-07-25', to: '2026-08-02' } }),
    ]
    const records = metric(period(summary(data({ entries }), DAY), PAST), KEYS.records)
    expect(records.value).toEqual({ n: 3, unit: 'count' })
    expect(records.basis).toMatch(/^2 операции и 1 итог периода/)
  })

  it('регулярные: ждут по месяцам, внесённая отметкой шаблона гаснет', () => {
    const entries = [entry({ date: '2026-08-15', recurringId: TEMPLATE.id })]
    const body = summary(data({ recurring: [TEMPLATE], entries }), DAY)
    expect(metric(period(body, PAST), KEYS.waiting).value).toEqual({ n: 0, unit: 'count' })
    const running = metric(period(body, RUNNING), KEYS.waiting)
    expect(running.value).toEqual({ n: 1, unit: 'count' })
    expect(running.basis).toContain('ждут 1 из 1')
  })

  it('регулярных не ждали — ноль и слова об этом', () => {
    const waiting = metric(period(summary(data(), DAY), RUNNING), KEYS.waiting)
    expect(waiting.value).toEqual({ n: 0, unit: 'count' })
    expect(waiting.basis).toContain('не ждали')
  })

  it('снимки — счётом дат, части одной даты — одна дата; день последнего — в основании', () => {
    const balances = [
      balance('2026-08-01'),
      balance('2026-09-01', { part: 'карта' }),
      balance('2026-09-01', { part: 'вклад' }),
      balance('2026-09-15'),
      balance('2026-09-28'), // после дня расчёта — не видно
    ]
    const body = summary(data({ balances }), DAY)
    const running = metric(period(body, RUNNING), KEYS.snapshots)
    expect(running.value).toEqual({ n: 2, unit: 'count' })
    expect(running.basis).toContain('последний — 15.09.2026')
    expect(metric(period(body, PAST), KEYS.snapshots).basis).toBe('снимок 01.08.2026')
  })

  it('в месяце снимка нет — ноль и день последнего', () => {
    const body = summary(data({ balances: [balance('2026-07-01')] }), DAY)
    const past = metric(period(body, PAST), KEYS.snapshots)
    expect(past.value).toEqual({ n: 0, unit: 'count' })
    expect(past.basis).toContain('последний — 01.07.2026')
  })
})

describe('срез итогов — «требует внимания» по правилам напоминаний', () => {
  it('прошлый месяц без записей — пункт с последним днём месяца и путём к загрузке', () => {
    const day = `2026-10-0${REMIND_FROM_DAY}`
    const body = summary(data({ entries: [entry({ date: '2026-08-10' })] }), day)
    expect(body.attention).toEqual([
      expect.objectContaining({ key: KEYS.monthMissing, count: null, day: '2026-09-30', link: '/import' }),
    ])
  })

  it('до своего числа и на пустой базе — не зовёт', () => {
    expect(summary(data({ entries: [entry({ date: '2026-08-10' })] }), '2026-10-02').attention).toEqual([])
    expect(summary(data({ entries: [] }), '2026-10-05').attention).toEqual([])
  })

  it('регулярные ждут — счётом и путём к «Операциям», с того же числа, что напоминание', () => {
    const day = `2026-09-${RECURRING_FROM_DAY}`
    // Август внесён — иначе рядом позвал бы и «Месяц не внесён».
    const withAugust = data({ recurring: [TEMPLATE], entries: [entry({ date: '2026-08-10' })] })
    const body = summary(withAugust, day)
    expect(body.attention).toEqual([
      expect.objectContaining({ key: KEYS.recurringWaiting, count: 1, day, link: '/entries' }),
    ])
    expect(summary(withAugust, `2026-09-0${RECURRING_FROM_DAY - 1}`).attention).toEqual([])
  })
})

describe('срез итогов — договор', () => {
  const full = data({
    accounts: [account({ loadedThrough: '2026-09-20' }), account({ id: 'cash', name: 'Кошелёк Маши' })],
    recurring: [TEMPLATE],
    entries: [entry({ date: '2026-08-10' }), entry({ date: undefined, period: { from: '2026-07-01', to: '2026-07-31' } })],
    balances: [balance('2026-08-01', { note: 'занял у Пети' })],
  })

  it('форма сходится с проверкой ядра в любой день, включая края месяца и года', () => {
    for (const day of ['2026-09-25', '2026-09-01', '2026-10-01', '2026-10-05', '2027-01-01', '2026-12-31']) {
      expect(() => checkSummary(buildSummary(summary(full, day), full, day))).not.toThrow()
    }
    const empty = data({ accounts: [], entries: [] })
    expect(() => checkSummary(buildSummary(summary(empty, DAY), empty, DAY))).not.toThrow()
  })

  it('ни названий, ни имён, ни заметок, ни сумм', () => {
    const text = JSON.stringify(summary(full, '2026-10-05'))
    for (const word of ['Синий банк', 'Кошелёк', 'Маши', 'Пет', 'Связь', 'Тариф', 'обед', 'занял', 'RUB', 'money']) {
      expect(text).not.toContain(word)
    }
  })
})
