import { describe, expect, it } from 'vitest'
import type { Account, Currency, Entry } from '../../app/model.ts'
import { entriesOfMonth, lastDayOn, makeEntry, type EntryData, type EntryDraft } from './entries.ts'

/** Суммы, счета и даты примеров выдуманы: код публичный (CLAUDE.md). */
const AT = '2026-09-20T10:00:00.000Z'

const RUB: Currency = { id: 'cur', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }

const BANK: Account = { id: 'acc-1', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0 }
const CASH: Account = { id: 'acc-2', updatedAt: AT, name: 'Наличные', currency: 'RUB', kind: 'savings', order: 1 }

const CATEGORIES = [
  { id: 'cat-food', side: 'expense' as const },
  { id: 'cat-pay', side: 'income' as const },
]

function data(entries: readonly Entry[] = []): EntryData {
  return { accounts: [BANK, CASH], currencies: [RUB], categories: CATEGORIES, entries }
}

function draft(fields: Partial<EntryDraft> = {}): EntryDraft {
  return { kind: 'expense', accountId: BANK.id, amount: '100', date: '2026-09-10', categoryId: 'cat-food', ...fields }
}

/** Запись, которая должна была получиться. Не получилась — тест падает внятно. */
function made(result: ReturnType<typeof makeEntry>): Entry {
  if ('problem' in result) throw new Error(`не записалось: ${result.problem}`)
  return result.entry
}

function problem(result: ReturnType<typeof makeEntry>): string {
  if ('entry' in result) throw new Error('записалось, хотя не должно было')
  return result.problem
}

describe('сумма', () => {
  it('в минимальных единицах валюты счёта, всегда положительная', () => {
    const entry = made(makeEntry(draft({ amount: '1 234,56' }), data()))
    expect(entry.money).toEqual({ amount: 123456, currency: 'RUB' })
  })

  it('со знаком не принимается: направление задаёт вид записи', () => {
    expect(problem(makeEntry(draft({ amount: '-100' }), data()))).toContain('Знак не ставится')
  })

  it('ноль — не сумма', () => {
    expect(problem(makeEntry(draft({ amount: '0' }), data()))).toContain('больше нуля')
  })

  it('валюты счёта нет в справочнике — запись не делается наугад', () => {
    const without: EntryData = { ...data(), currencies: [] }
    expect(problem(makeEntry(draft(), without))).toBe('валюты RUB нет в справочнике')
  })
})

describe('дата или период', () => {
  it('без того и другого записи не бывает', () => {
    expect(problem(makeEntry(draft({ date: undefined }), data()))).toBe('не указана дата')
  })

  it('и то и другое сразу — тоже нет', () => {
    const both = draft({ period: { from: '2026-09-01', to: '2026-09-30' } })
    expect(problem(makeEntry(both, data()))).toContain('или на дату, или за период')
  })

  it('период кончается раньше, чем начинается', () => {
    const back = draft({ date: undefined, period: { from: '2026-09-30', to: '2026-09-01' } })
    expect(problem(makeEntry(back, data()))).toContain('кончается раньше')
  })

  it('итог периода живёт без категории (Р-12)', () => {
    const total = draft({ date: undefined, categoryId: undefined, period: { from: '2026-01-05', to: '2026-02-14' } })
    const entry = made(makeEntry(total, data()))
    expect(entry.period).toEqual({ from: '2026-01-05', to: '2026-02-14' })
    expect('categoryId' in entry).toBe(false)
    expect('date' in entry).toBe(false)
  })

  it('обычная операция без категории не заводится', () => {
    expect(problem(makeEntry(draft({ categoryId: undefined }), data()))).toBe('не выбрана категория')
  })
})

describe('категории', () => {
  it('доходная категория у расхода не принимается', () => {
    expect(problem(makeEntry(draft({ categoryId: 'cat-pay' }), data()))).toContain('доходная категория')
  })

  it('расходная категория у дохода не принимается', () => {
    expect(problem(makeEntry(draft({ kind: 'income', categoryId: 'cat-food' }), data()))).toContain('расходная категория')
  })
})

describe('перевод между своими счетами (Р-12)', () => {
  it('категории у него нет', () => {
    const move = draft({ kind: 'transfer', categoryId: 'cat-food' })
    expect(problem(makeEntry(move, data()))).toContain('категории нет')
  })

  it('второй счёт необязателен', () => {
    const entry = made(makeEntry(draft({ kind: 'transfer', categoryId: undefined }), data()))
    expect('toAccountId' in entry).toBe(false)
    expect(entry.kind).toBe('transfer')
  })

  it('движение внутри одного счёта не записывается вовсе', () => {
    const inside = draft({ kind: 'transfer', categoryId: undefined, toAccountId: BANK.id })
    expect(problem(makeEntry(inside, data()))).toContain('внутри одного счёта')
  })

  it('особым бывает расход, а не перевод', () => {
    const odd = draft({ kind: 'transfer', categoryId: undefined, special: true })
    expect(problem(makeEntry(odd, data()))).toContain('особой бывает трата')
  })

  it('второй счёт из справочника записывается', () => {
    const move = draft({ kind: 'transfer', categoryId: undefined, toAccountId: CASH.id })
    expect(made(makeEntry(move, data())).toAccountId).toBe(CASH.id)
  })
})

describe('либо итог, либо операции (Р-02)', () => {
  const operation: Entry = {
    id: 'e-1',
    updatedAt: AT,
    kind: 'expense',
    accountId: BANK.id,
    money: { amount: 5000, currency: 'RUB' },
    date: '2026-09-10',
  }

  const total: Entry = {
    id: 'e-2',
    updatedAt: AT,
    kind: 'expense',
    accountId: BANK.id,
    money: { amount: 900000, currency: 'RUB' },
    period: { from: '2026-09-01', to: '2026-09-30' },
  }

  it('итог не ложится на период, где уже есть операции', () => {
    const wants = draft({ date: undefined, categoryId: undefined, period: { from: '2026-09-01', to: '2026-09-30' } })
    expect(problem(makeEntry(wants, data([operation])))).toContain('уже есть операции')
  })

  it('операция не ложится в день, покрытый итогом', () => {
    expect(problem(makeEntry(draft({ date: '2026-09-15' }), data([total])))).toContain('покрыт итогом')
  })

  it('два итога с пересекающимися периодами не уживаются', () => {
    const wants = draft({ date: undefined, categoryId: undefined, period: { from: '2026-09-25', to: '2026-10-20' } })
    expect(problem(makeEntry(wants, data([total])))).toContain('периоды пересекаются')
  })

  it('на другом счёте то же самое законно: правило про счёт, а не про месяц', () => {
    const elsewhere = draft({ accountId: CASH.id, date: '2026-09-15' })
    expect(made(makeEntry(elsewhere, data([total]))).accountId).toBe(CASH.id)
  })

  it('перевод итогу не мешает: он не расход и не доход', () => {
    const move: Entry = { ...operation, id: 'e-3', kind: 'transfer', date: '2026-09-12' }
    const wants = draft({ date: undefined, categoryId: undefined, period: { from: '2026-09-01', to: '2026-09-30' } })
    expect(made(makeEntry(wants, data([move]))).period?.to).toBe('2026-09-30')
  })

  it('обычный и особый итоги за один период уживаются (Р-14)', () => {
    const usual: Entry = { ...total, id: 'e-4' }
    const special = draft({
      date: undefined,
      categoryId: undefined,
      special: true,
      period: { from: '2026-09-01', to: '2026-09-30' },
    })
    expect(made(makeEntry(special, data([usual]))).special).toBe(true)
  })

  it('два особых итога на тот же период всё же не уживаются', () => {
    const special: Entry = { ...total, id: 'e-5', special: true }
    const another = draft({
      date: undefined,
      categoryId: undefined,
      special: true,
      period: { from: '2026-09-10', to: '2026-10-05' },
    })
    expect(problem(makeEntry(another, data([special])))).toContain('периоды пересекаются')
  })

  it('доход в период, покрытый итогом расхода, вносится: это разные величины', () => {
    const income = draft({ kind: 'income', date: '2026-09-15', categoryId: 'cat-pay' })
    expect(made(makeEntry(income, data([total]))).kind).toBe('income')
  })

  it('особая операция не спорит с обычным итогом того же периода', () => {
    const odd = draft({ date: '2026-09-15', special: true })
    expect(made(makeEntry(odd, data([total]))).special).toBe(true)
  })

  it('удалённая запись не мешает: надгробие — не операция', () => {
    const gone: Entry = { ...operation, deleted: true }
    const wants = draft({ date: undefined, categoryId: undefined, period: { from: '2026-09-01', to: '2026-09-30' } })
    expect(made(makeEntry(wants, data([gone]))).period?.from).toBe('2026-09-01')
  })
})

describe('пустые поля не пишутся', () => {
  it('запись держит только то, что сказано', () => {
    const entry = made(makeEntry(draft({ note: '   ' }), data()))
    expect(Object.keys(entry).sort()).toEqual(['accountId', 'categoryId', 'date', 'id', 'kind', 'money', 'updatedAt'])
  })

  it('внесённая руками запись ключа импорта не получает (Р-12)', () => {
    expect('ext' in made(makeEntry(draft(), data()))).toBe(false)
  })
})

describe('чтение месяца', () => {
  const list: Entry[] = [
    { id: 'a', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 1, currency: 'RUB' }, date: '2026-09-10', time: '09:00' },
    { id: 'b', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 2, currency: 'RUB' }, date: '2026-09-10', time: '19:00' },
    { id: 'c', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 3, currency: 'RUB' }, date: '2026-08-31' },
    { id: 'd', updatedAt: AT, kind: 'expense', accountId: CASH.id, money: { amount: 4, currency: 'RUB' }, period: { from: '2026-08-20', to: '2026-09-05' } },
  ]

  it('позже — выше; запись без времени не теряется', () => {
    expect(entriesOfMonth(list, '2026-09').operations.map((each) => each.id)).toEqual(['b', 'a'])
  })

  it('итог, задевающий месяц, назван отдельно: по месяцам он не дробится', () => {
    const month = entriesOfMonth(list, '2026-09')
    expect(month.periods.map((each) => each.id)).toEqual(['d'])
    expect(entriesOfMonth(list, '2026-08').periods.map((each) => each.id)).toEqual(['d'])
  })

  it('последний загруженный день счёта — для промпта импорта', () => {
    expect(lastDayOn(list, BANK.id)).toBe('2026-09-10')
    expect(lastDayOn(list, CASH.id)).toBe('2026-09-05')
    expect(lastDayOn(list, 'нет такого')).toBeNull()
  })
})
