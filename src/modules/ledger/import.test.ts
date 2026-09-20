import { describe, expect, it } from 'vitest'
import type { Account, Category, Currency, Entry } from '../../app/model.ts'
import type { ImportContext } from '../../shared/core/importing.ts'
import {
  importAccounts,
  importCategories,
  importCurrencies,
  importEntries,
  importRates,
  ledgerPromptNotes,
  promptSamples,
  replacedTotals,
  TRANSFER_MATCH_DAYS,
  type LedgerImportData,
} from './import.ts'

/**
 * Всё выдумано: банки, описания, суммы. Промпт и примеры уезжают к тому,
 * с кем идёт беседа (CLAUDE.md, «Личные данные»).
 */
const AT = '2026-09-20T10:00:00.000Z'

let counter = 0
function context(): ImportContext {
  counter = 0
  return { newId: () => `id-${++counter}`, now: AT }
}

const RUB: Currency = { id: 'cur-rub', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }
const BANK: Account = { id: 'acc-1', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0 }
const CASH: Account = { id: 'acc-2', updatedAt: AT, name: 'Наличные', currency: 'RUB', kind: 'savings', order: 1 }
const FOOD: Category = { id: 'cat-1', updatedAt: AT, name: 'Продукты', side: 'expense', order: 0 }

function base(over: Partial<LedgerImportData> = {}): LedgerImportData {
  return { currencies: [RUB], accounts: [BANK, CASH], categories: [FOOD], entries: [], rates: [], ...over }
}

describe('валюты', () => {
  it('заводит новую и пропускает уже заведённую', () => {
    const plan = importCurrencies(
      [
        { code: 'RUB', name: 'Рубль', decimals: 2 },
        { code: 'usd', name: 'Доллар', decimals: 2 },
      ],
      base(),
      context(),
    )
    expect(plan.writes.currencies?.map((each) => each.code)).toEqual(['USD'])
    expect(plan.skipped).toBe(1)
  })

  it('без кода запись не проходит и называется', () => {
    const plan = importCurrencies([{ name: 'Что-то' }], base(), context())
    expect(plan.writes.currencies ?? []).toHaveLength(0)
    expect(plan.issues[0]?.reason).toContain('нет кода')
  })
})

describe('счета', () => {
  it('без валюты счёт не заводится: выдумать её нельзя', () => {
    const plan = importAccounts([{ name: 'Зелёный банк' }], base(), context())
    expect(plan.writes.accounts ?? []).toHaveLength(0)
    expect(plan.issues[0]?.reason).toContain('выдумать её нельзя')
  })

  it('валюты нет в справочнике — счёт назван, а не заведён наугад', () => {
    const plan = importAccounts([{ name: 'Кошелёк', currency: 'BTC' }], base(), context())
    expect(plan.issues[0]?.reason).toContain('нет в справочнике')
  })

  it('существующий счёт пропускается без учёта регистра', () => {
    const plan = importAccounts([{ name: 'синий банк', currency: 'RUB' }], base(), context())
    expect(plan.skipped).toBe(1)
  })
})

describe('категории', () => {
  it('сторона обязательна и понимается по-русски тоже', () => {
    const plan = importCategories(
      [
        { name: 'Зарплата', side: 'доход' },
        { name: 'Такси', side: 'непонятно' },
      ],
      base(),
      context(),
    )
    expect(plan.writes.categories?.map((each) => each.side)).toEqual(['income'])
    expect(plan.issues[0]?.reason).toContain('не "expense" и не "income"')
  })

  it('одноимённые в разных сторонах законны', () => {
    const plan = importCategories([{ name: 'Продукты', side: 'income' }], base(), context())
    expect(plan.writes.categories).toHaveLength(1)
    expect(plan.skipped).toBe(0)
  })
})

describe('курсы', () => {
  it('тот же курс на ту же дату второй раз не заводится', () => {
    const was = base({
      rates: [{ id: 'r', updatedAt: AT, date: '2026-09-15', from: 'USD', to: 'RUB', rate: 80, source: 'manual' }],
    })
    const plan = importRates([{ date: '2026-09-15', from: 'USD', to: 'RUB', rate: 81.42 }], was, context())
    expect(plan.skipped).toBe(1)
    expect(plan.writes.rates ?? []).toHaveLength(0)
  })

  it('курс — число больше нуля', () => {
    const plan = importRates([{ date: '2026-09-15', from: 'USD', to: 'RUB', rate: 0 }], base(), context())
    expect(plan.issues[0]?.reason).toContain('больше нуля')
  })
})

describe('записи учёта', () => {
  const line = {
    kind: 'expense',
    account: 'Синий банк',
    amount: 349.9,
    date: '2026-09-14',
    time: '12:05',
    category: 'Продукты',
    bankText: 'МАГАЗИН У ДОМА 349.90',
  }

  it('сумма переводится в минимальные единицы валюты счёта', () => {
    const plan = importEntries([line], base(), context())
    const entry = plan.writes.entries?.[0]
    expect(entry?.money).toEqual({ amount: 34990, currency: 'RUB' })
    expect(entry?.bankText).toBe('МАГАЗИН У ДОМА 349.90')
  })

  it('счёта нет — запись названа, а счёт не выдуман', () => {
    const plan = importEntries([{ ...line, account: 'Чужой банк' }], base(), context())
    expect(plan.writes.entries ?? []).toHaveLength(0)
    expect(plan.issues[0]?.reason).toContain('заведите его или добавьте в раздел')
  })

  it('недостающая категория заводится сама', () => {
    const plan = importEntries([{ ...line, category: 'Аптека' }], base(), context())
    expect(plan.writes.categories?.map((each) => each.name)).toEqual(['Аптека'])
    expect(plan.writes.entries?.[0]?.categoryId).toBe(plan.writes.categories?.[0]?.id)
  })

  it('лишние знаки округляются и это названо, а не проглочено', () => {
    const plan = importEntries([{ ...line, amount: '349.905' }], base(), context())
    expect(plan.writes.entries?.[0]?.money.amount).toBe(34991)
    expect(plan.issues.some((each) => each.reason.includes('округлена'))).toBe(true)
  })

  it('итог за период приходит с границами вместо даты', () => {
    const total = { kind: 'expense', account: 'Синий банк', amount: 1000, periodFrom: '2026-01-05', periodTo: '2026-02-14' }
    const entry = importEntries([total], base(), context()).writes.entries?.[0]
    expect(entry?.period).toEqual({ from: '2026-01-05', to: '2026-02-14' })
    expect(entry?.date).toBeUndefined()
  })

  it('у итога периода категория не обязательна, у операции — обязательна', () => {
    const noCategory = { kind: 'expense', account: 'Синий банк', amount: 100, date: '2026-09-14' }
    expect(importEntries([noCategory], base(), context()).issues[0]?.reason).toContain('нет категории')
  })
})

describe('ключ импорта и повтор (Р-12, п. 4)', () => {
  const file = [
    { kind: 'expense', account: 'Синий банк', amount: 100, date: '2026-09-14', category: 'Продукты', bankText: 'КОФЕ' },
    { kind: 'expense', account: 'Синий банк', amount: 100, date: '2026-09-14', category: 'Продукты', bankText: 'КОФЕ' },
  ]

  it('две одинаковые строки за день получают разные ключи', () => {
    const plan = importEntries(file, base(), context())
    const keys = plan.writes.entries?.map((each) => each.ext)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })

  it('та же выписка, загруженная второй раз, не записывает ничего', () => {
    const first = importEntries(file, base(), context())
    const second = importEntries(file, base({ entries: first.writes.entries ?? [] }), context())
    expect(second.writes.entries ?? []).toHaveLength(0)
    expect(second.skipped).toBe(2)
  })

  it('код банка делает ключ сам, и повтор ловится по нему', () => {
    const withId = [{ ...file[0], bankId: 'A-77' }]
    const first = importEntries(withId, base(), context())
    expect(first.writes.entries?.[0]?.ext).toBe('acc-1:A-77')
    const second = importEntries(withId, base({ entries: first.writes.entries ?? [] }), context())
    expect(second.skipped).toBe(1)
  })

  it('дозагрузка с последнего дня включительно не дублирует уже загруженное', () => {
    const first = importEntries(file, base(), context())
    const again = [...file, { kind: 'expense', account: 'Синий банк', amount: 250, date: '2026-09-15', category: 'Продукты', bankText: 'ЧАЙ' }]
    const second = importEntries(again, base({ entries: first.writes.entries ?? [] }), context())
    expect(second.writes.entries?.map((each) => each.bankText)).toEqual(['ЧАЙ'])
    expect(second.skipped).toBe(2)
  })
})

describe('склейка встречных переводов (Р-12, п. 3)', () => {
  const out = { kind: 'transfer', account: 'Синий банк', amount: 5000, date: '2026-09-15', bankText: 'Перевод' }
  const back = { kind: 'transfer', account: 'Наличные', amount: 5000, date: '2026-09-15', bankText: 'Поступление' }

  it('две стороны одного перевода становятся одной записью', () => {
    const plan = importEntries([out, back], base(), context())
    expect(plan.writes.entries).toHaveLength(1)
    expect(plan.writes.entries?.[0]?.toAccountId).toBe(CASH.id)
  })

  it('даты дальше допустимого не склеиваются: несклеенное остаётся видно', () => {
    const far = { ...back, date: '2026-09-25' }
    const plan = importEntries([out, far], base(), context())
    expect(plan.writes.entries).toHaveLength(2)
  })

  it('на границе допустимого ещё склеивается', () => {
    const edge = { ...back, date: '2026-09-18' }
    expect(TRANSFER_MATCH_DAYS).toBe(3)
    expect(importEntries([out, edge], base(), context()).writes.entries).toHaveLength(1)
  })

  it('расход и доход той же суммы не склеиваются: склеиваются только помеченные переводом', () => {
    const expense = { ...out, kind: 'expense', category: 'Продукты' }
    const income = { ...back, kind: 'income', category: 'Продукты' }
    expect(importEntries([expense, income], base(), context()).writes.entries).toHaveLength(2)
  })

  it('две стороны на одном счёте не склеиваются: это движение внутри счёта', () => {
    const same = { ...back, account: 'Синий банк' }
    expect(importEntries([out, same], base(), context()).writes.entries).toHaveLength(2)
  })
})

describe('итог заменяется операциями (Р-02)', () => {
  const total: Entry = {
    id: 'total',
    updatedAt: AT,
    kind: 'expense',
    accountId: BANK.id,
    money: { amount: 100000, currency: 'RUB' },
    period: { from: '2026-09-01', to: '2026-09-30' },
  }

  const coming: Entry[] = [
    { id: 'a', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 60000, currency: 'RUB' }, date: '2026-09-10' },
    { id: 'b', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 50000, currency: 'RUB' }, date: '2026-09-20' },
  ]

  it('итог уходит надгробием, а разница называется словами', () => {
    const { tombstones, notes } = replacedTotals(base({ entries: [total] }), coming, AT)
    expect(tombstones.map((each) => each.id)).toEqual(['total'])
    expect(tombstones[0]?.deleted).toBe(true)
    expect(notes[0]).toContain('больше итога на')
    expect(notes[0]).toContain('100,00')
  })

  it('операции другого счёта итога не трогают', () => {
    const elsewhere = coming.map((each) => ({ ...each, accountId: CASH.id }))
    expect(replacedTotals(base({ entries: [total] }), elsewhere, AT).tombstones).toHaveLength(0)
  })

  it('операции вне периода итога его не заменяют', () => {
    const later = coming.map((each) => ({ ...each, date: '2026-10-10' }))
    expect(replacedTotals(base({ entries: [total] }), later, AT).tombstones).toHaveLength(0)
  })
})

describe('промпт знает справочники и загруженное (Р-12, пп. 5, 8)', () => {
  const loaded: Entry[] = [
    { id: 'a', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 100, currency: 'RUB' }, date: '2026-09-14', categoryId: FOOD.id, bankText: 'МАГАЗИН У ДОМА' },
    { id: 'b', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 200, currency: 'RUB' }, date: '2026-09-15', categoryId: FOOD.id, bankText: 'МАГАЗИН У ДОМА' },
    { id: 'c', updatedAt: AT, kind: 'expense', accountId: BANK.id, money: { amount: 300, currency: 'RUB' }, date: '2026-09-16', categoryId: FOOD.id, bankText: 'АПТЕКА' },
  ]

  it('самые частые описания идут первыми и вместе со своей категорией', () => {
    const samples = promptSamples(base({ entries: loaded }))
    expect(samples[0]).toEqual({ text: 'МАГАЗИН У ДОМА', category: 'Продукты' })
    expect(samples).toHaveLength(2)
  })

  it('описание без категории в образцы не идёт: показывать нечего', () => {
    const noCategory = loaded.map(({ categoryId: _, ...rest }) => rest)
    expect(promptSamples(base({ entries: noCategory }))).toHaveLength(0)
  })

  it('по каждому счёту сказано, с какого дня брать выписку', () => {
    const notes = ledgerPromptNotes(base({ entries: loaded }), new Map([[BANK.id, '2026-09-16'], [CASH.id, null]]))
    expect(notes).toContain('«Синий банк» (RUB): операции загружены по 2026-09-16 включительно')
    expect(notes).toContain('«Наличные» (RUB): операций ещё нет')
    expect(notes).toContain('Расходные категории: Продукты.')
  })

  it('счёт истории в промпт не идёт: выписки на него не грузятся', () => {
    const ledgerOnly: Account = { ...BANK, id: 'acc-3', name: 'Таблица', ledgerOnly: true }
    const notes = ledgerPromptNotes(base({ accounts: [BANK, ledgerOnly] }), new Map())
    expect(notes).not.toContain('Таблица')
  })
})
