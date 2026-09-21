import { describe, expect, it } from 'vitest'
import type { Account, Category, Entry, Recurring } from '../../app/model.ts'
import {
  createRecurring,
  dayFor,
  dueIn,
  dueThisMonth,
  enterAll,
  enterRecurring,
  entriesFor,
  incomeNotEntered,
  leftToPay,
  monthsBetween,
  recurringProblem,
  type RecurringData,
} from './recurring.ts'

/** Названия и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'
const TODAY = '2026-09-20'

const BANK: Account = { id: 'acc', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0 }
const LINK: Category = { id: 'cat-link', updatedAt: AT, name: 'Связь', side: 'expense', order: 0 }
const PAY: Category = { id: 'cat-pay', updatedAt: AT, name: 'Стипендия', side: 'income', order: 0 }

function recurring(fields: Partial<Recurring> & { id: string; name: string }): Recurring {
  return {
    updatedAt: AT,
    categoryId: LINK.id,
    accountId: BANK.id,
    expected: { amount: 100000, currency: 'RUB' },
    every: { months: 1 },
    from: '2026-01',
    order: 0,
    ...fields,
  }
}

function data(over: Partial<RecurringData> = {}): RecurringData {
  return {
    recurring: [],
    categories: [LINK, PAY],
    accounts: [BANK],
    entries: [],
    ...over,
  }
}

function entered(result: ReturnType<typeof enterRecurring>): Entry {
  if ('problem' in result) throw new Error(`не внеслось: ${result.problem}`)
  return result.entry
}

describe('когда шаблон ждёт платежа', () => {
  it('раз в месяц ждёт каждый месяц с начала действия', () => {
    const monthly = recurring({ id: 'r', name: 'Связь', from: '2026-03' })
    expect(dueIn(monthly, '2026-02')).toBe(false)
    expect(dueIn(monthly, '2026-03')).toBe(true)
    expect(dueIn(monthly, '2026-09')).toBe(true)
  })

  it('раз в год считается от начала, а не от января', () => {
    const yearly = recurring({ id: 'r', name: 'Страховка', from: '2026-03', every: { months: 12 } })
    expect(dueIn(yearly, '2027-03')).toBe(true)
    expect(dueIn(yearly, '2027-01')).toBe(false)
    expect(dueIn(yearly, '2026-09')).toBe(false)
  })

  it('после месяца конца не ждёт', () => {
    const ended = recurring({ id: 'r', name: 'Связь', to: '2026-06' })
    expect(dueIn(ended, '2026-06')).toBe(true)
    expect(dueIn(ended, '2026-07')).toBe(false)
  })

  it('надгробие не ждёт ничего', () => {
    expect(dueIn(recurring({ id: 'r', name: 'Связь', deleted: true }), '2026-09')).toBe(false)
  })

  it('месяцы считаются через год правильно', () => {
    expect(monthsBetween('2026-11', '2027-02')).toBe(3)
    expect(monthsBetween('2027-02', '2026-11')).toBe(-3)
  })
})

describe('внесена или нет', () => {
  const template = recurring({ id: 'r', name: 'Связь' })

  it('запись с «за какой месяц» закрывает тот месяц, а не месяц платежа', () => {
    const paid: Entry = {
      id: 'e',
      updatedAt: AT,
      kind: 'expense',
      accountId: BANK.id,
      money: { amount: 100000, currency: 'RUB' },
      date: '2026-09-05',
      recurringId: 'r',
      for: '2026-08',
    }
    expect(entriesFor([paid], 'r', '2026-08')).toHaveLength(1)
    expect(entriesFor([paid], 'r', '2026-09')).toHaveLength(0)
  })

  it('без «за какой месяц» считается по дате платежа', () => {
    const paid: Entry = {
      id: 'e',
      updatedAt: AT,
      kind: 'expense',
      accountId: BANK.id,
      money: { amount: 100000, currency: 'RUB' },
      date: '2026-09-05',
      recurringId: 'r',
    }
    expect(entriesFor([paid], 'r', '2026-09')).toHaveLength(1)
  })

  it('внесённое из списка не исчезает — видно, что платёж был', () => {
    const paid: Entry = {
      id: 'e',
      updatedAt: AT,
      kind: 'expense',
      accountId: BANK.id,
      money: { amount: 90000, currency: 'RUB' },
      date: '2026-09-05',
      recurringId: 'r',
    }
    const [due] = dueThisMonth(data({ recurring: [template], entries: [paid] }), '2026-09')
    expect(due?.entries).toHaveLength(1)
    expect(due?.paid).toBe(90000)
    expect(leftToPay(due!)).toBe(10000)
  })

  it('заплачено больше ожидаемого — остаток отрицательный, а не ноль', () => {
    const paid: Entry = {
      id: 'e',
      updatedAt: AT,
      kind: 'expense',
      accountId: BANK.id,
      money: { amount: 120000, currency: 'RUB' },
      date: '2026-09-05',
      recurringId: 'r',
    }
    const [due] = dueThisMonth(data({ recurring: [template], entries: [paid] }), '2026-09')
    expect(leftToPay(due!)).toBe(-20000)
  })
})

describe('день записи', () => {
  it('текущий месяц — сегодня', () => {
    expect(dayFor('2026-09', TODAY)).toBe(TODAY)
  })

  it('прошлый месяц — его последний день, чтобы расход лёг туда, куда надо', () => {
    expect(dayFor('2026-08', TODAY)).toBe('2026-08-31')
    expect(dayFor('2026-02', TODAY)).toBe('2026-02-28')
  })

  it('високосный февраль считается верно', () => {
    expect(dayFor('2028-02', TODAY)).toBe('2028-02-29')
  })
})

describe('внести по шаблону', () => {
  it('вид записи берётся у стороны категории: стипендия — доход', () => {
    const wage = recurring({ id: 'r', name: 'Стипендия', categoryId: PAY.id })
    const entry = entered(enterRecurring(wage, data({ recurring: [wage] }), '2026-09', TODAY))
    expect(entry.kind).toBe('income')
    expect(entry.recurringId).toBe('r')
    expect(entry.for).toBe('2026-09')
  })

  it('расход — расходом, сумма ожидаемая', () => {
    const link = recurring({ id: 'r', name: 'Связь' })
    const entry = entered(enterRecurring(link, data({ recurring: [link] }), '2026-09', TODAY))
    expect(entry.kind).toBe('expense')
    expect(entry.money).toEqual({ amount: 100000, currency: 'RUB' })
  })

  it('без счёта не вносится: класть запись наугад некуда', () => {
    const noAccount = recurring({ id: 'r', name: 'Связь', accountId: undefined })
    const result = enterRecurring(noAccount, data({ recurring: [noAccount] }), '2026-09', TODAY)
    expect('problem' in result && result.problem).toContain('не выбран счёт')
  })

  it('валюта шаблона и счёта расходятся — это называется, а не пересчитывается наугад', () => {
    const other = recurring({ id: 'r', name: 'Подписка', expected: { amount: 500, currency: 'USD' } })
    const result = enterRecurring(other, data({ recurring: [other] }), '2026-09', TODAY)
    expect('problem' in result && result.problem).toContain('ведётся в RUB')
  })

  it('«Внести все» пропускает уже внесённое', () => {
    const one = recurring({ id: 'r1', name: 'Связь' })
    const two = recurring({ id: 'r2', name: 'Интернет', order: 1 })
    const paid: Entry = {
      id: 'e',
      updatedAt: AT,
      kind: 'expense',
      accountId: BANK.id,
      money: { amount: 100000, currency: 'RUB' },
      date: '2026-09-05',
      recurringId: 'r1',
    }
    const all = enterAll(data({ recurring: [one, two], entries: [paid] }), '2026-09', TODAY)
    expect(all.entries.map((each) => each.recurringId)).toEqual(['r2'])
    expect(all.problems).toEqual([])
  })

  it('«Внести все» называет то, что внести не вышло, и вносит остальное', () => {
    const good = recurring({ id: 'r1', name: 'Связь' })
    const broken = recurring({ id: 'r2', name: 'Подписка', order: 1, accountId: undefined })
    const all = enterAll(data({ recurring: [good, broken] }), '2026-09', TODAY)
    expect(all.entries).toHaveLength(1)
    expect(all.problems[0]).toContain('Подписка')
  })
})

describe('заведение шаблона', () => {
  const draft = {
    name: 'Связь',
    categoryId: LINK.id,
    accountId: BANK.id,
    expected: { amount: 100000, currency: 'RUB' },
    everyMonths: 1,
    from: '2026-01',
  }

  it('годный шаблон заводится', () => {
    expect(recurringProblem(data(), draft)).toBeNull()
    expect(createRecurring([], draft).every).toEqual({ months: 1 })
  })

  it('повтор — целое число месяцев больше нуля', () => {
    expect(recurringProblem(data(), { ...draft, everyMonths: 0 })).toContain('целое число месяцев')
    expect(recurringProblem(data(), { ...draft, everyMonths: 1.5 })).toContain('целое число месяцев')
  })

  it('сумма — больше нуля', () => {
    expect(recurringProblem(data(), { ...draft, expected: { amount: 0, currency: 'RUB' } })).toContain('больше нуля')
  })

  it('конец раньше начала не принимается', () => {
    expect(recurringProblem(data(), { ...draft, to: '2025-12' })).toContain('кончается раньше')
  })

  it('двойника по названию не заводим', () => {
    const was = [recurring({ id: 'r', name: 'Связь' })]
    expect(recurringProblem(data({ recurring: was }), draft)).toContain('уже есть')
  })

  it('пустые поля в запись не пишутся', () => {
    const made = createRecurring([], { ...draft, accountId: undefined })
    expect('accountId' in made).toBe(false)
    expect('to' in made).toBe(false)
  })
})

describe('доход, которого ждали и не дождались (Р-23)', () => {
  const stipend: Recurring = {
    id: 'r-income',
    updatedAt: AT,
    name: 'Стипендия',
    categoryId: 'cat-income',
    accountId: 'acc',
    expected: { amount: 2500000, currency: 'RUB' },
    every: { months: 1 },
    from: '2026-01',
    order: 0,
  }
  const income: Category = { id: 'cat-income', updatedAt: AT, name: 'Стипендия', side: 'income', order: 0 }
  const spend: Category = { id: 'cat-spend', updatedAt: AT, name: 'Связь', side: 'expense', order: 1 }
  const account: Account = { id: 'acc', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0 }

  function base(entries: Entry[] = []): RecurringData {
    return { recurring: [stipend], categories: [income, spend], accounts: [account], entries }
  }

  it('доходная регулярная без записи названа', () => {
    expect(incomeNotEntered(base(), '2026-09').map((each) => each.recurring.name)).toEqual(['Стипендия'])
  })

  it('отмеченная — молчит', () => {
    const paid: Entry = {
      id: 'e1',
      updatedAt: AT,
      kind: 'income',
      accountId: 'acc',
      money: { amount: 2500000, currency: 'RUB' },
      date: '2026-09-25',
      categoryId: 'cat-income',
      recurringId: 'r-income',
    }
    expect(incomeNotEntered(base([paid]), '2026-09')).toEqual([])
  })

  it('расходная регулярная сюда не идёт: она не про полноту дохода', () => {
    const phone: Recurring = { ...stipend, id: 'r-spend', name: 'Связь', categoryId: 'cat-spend' }
    const data: RecurringData = { ...base(), recurring: [phone] }
    expect(incomeNotEntered(data, '2026-09')).toEqual([])
  })

  it('месяц, в котором шаблона ещё не ждут, молчит', () => {
    expect(incomeNotEntered(base(), '2025-12')).toEqual([])
  })
})
