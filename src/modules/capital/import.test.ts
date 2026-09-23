import { describe, expect, it } from 'vitest'
import type { Account, Balance, Currency, Note } from '../../app/model.ts'
import {
  balancesImportSpec,
  capitalSpecs,
  importBalances,
  importNotes,
  notesImportSpec,
  type CapitalImportData,
} from './import.ts'

/** Счета и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const currencies: Currency[] = [
  { id: 'c1', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 },
  { id: 'c3', updatedAt: AT, code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 }, order: 2 },
]

function account(id: string, name: string, fields: Partial<Account> = {}): Account {
  return { id, updatedAt: AT, name, currency: 'RUB', kind: 'savings', order: 0, ...fields }
}

const accounts: Account[] = [
  account('cash', 'Наличные'),
  account('bank', 'Банк'),
  account('wallet', 'Кошелёк', { currency: 'BTC' }),
  account('history', 'Таблица (история)', { ledgerOnly: true }),
]

let ids = 0
const ctx = { newId: () => `id-${++ids}`, now: '2026-09-23T10:00:00.000Z' }

function data(balances: Balance[] = [], notes: Note[] = []): CapitalImportData {
  return { currencies, accounts, balances, notes }
}

describe('раздел «balances»', () => {
  it('пример промпта проходит свою же проверку', () => {
    const plan = importBalances(balancesImportSpec.example, data(), ctx)
    expect(plan.issues).toEqual([])
    expect(plan.writes.balances).toHaveLength(3)
  })

  it('отложенный платёж ложится со знаком минус (Р-35)', () => {
    const plan = importBalances(balancesImportSpec.example, data(), ctx)
    const card = plan.writes.balances?.find((each) => each.part === 'кредитка')
    expect(card?.amount).toBe(-2000000)
  })

  it('биткойн — в BTC, в сатоши без потерь', () => {
    const plan = importBalances([{ account: 'Кошелёк', date: '2026-09-01', amount: 0.02163 }], data(), ctx)
    expect(plan.writes.balances?.[0]?.amount).toBe(2163000)
  })

  it('тот же снимок второй раз не удваивается: ключ — счёт, дата и часть', () => {
    const first = importBalances(balancesImportSpec.example, data(), ctx)
    const again = importBalances(balancesImportSpec.example, data(first.writes.balances ?? []), ctx)
    expect(again.writes.balances).toEqual([])
    expect(again.skipped).toBe(3)
  })

  it('на одну дату — либо без частей, либо по частям (Р-12)', () => {
    const plan = importBalances(
      [
        { account: 'Банк', date: '2026-09-01', amount: 100 },
        { account: 'Банк', date: '2026-09-01', part: 'на счёте', amount: 100 },
      ],
      data(),
      ctx,
    )
    expect(plan.writes.balances).toHaveLength(1)
    expect(plan.issues.map((each) => each.reason)).toEqual([
      'на 2026-09-01 у счёта уже есть снимок без частей — вместе они не складываются',
    ])
  })

  it('отложенный платёж без части — отказ', () => {
    const plan = importBalances([{ account: 'Банк', date: '2026-09-01', amount: 100, deferred: true }], data(), ctx)
    expect(plan.writes.balances).toEqual([])
    expect(plan.issues[0]?.reason).toContain('только частью счёта')
  })

  it('счёт истории снимков не получает', () => {
    const plan = importBalances([{ account: 'Таблица (история)', date: '2026-09-01', amount: 100 }], data(), ctx)
    expect(plan.issues[0]?.reason).toContain('счёт истории')
  })

  it('незнакомый счёт наугад не заводится — назван с причиной (Р-13)', () => {
    const plan = importBalances([{ account: 'Сейф', date: '2026-09-01', amount: 100 }], data(), ctx)
    expect(plan.issues).toEqual([
      { section: 'balances', title: 'снимок «Сейф»', reason: 'счёта «Сейф» нет — заведите его в разделе «accounts» с валютой' },
    ])
  })

  it('сумма со знаком — отказ: направление у снимка задаёт "deferred", а не минус', () => {
    const plan = importBalances([{ account: 'Банк', date: '2026-09-01', amount: -100 }], data(), ctx)
    expect(plan.issues[0]?.reason).toBe('сумма «-100» — не число без знака')
  })

  it('лишние знаки округляются, и это названо', () => {
    const plan = importBalances([{ account: 'Банк', date: '2026-09-01', amount: 100.555 }], data(), ctx)
    expect(plan.writes.balances?.[0]?.amount).toBe(10056)
    expect(plan.issues.map((each) => each.title)).toEqual(['округление'])
  })

  it('заметка к снимку переносится', () => {
    const plan = importBalances([{ account: 'Банк', date: '2026-09-01', amount: 1, note: 'без мелочи' }], data(), ctx)
    expect(plan.writes.balances?.[0]?.note).toBe('без мелочи')
  })
})

describe('раздел «notes»', () => {
  it('пример промпта проходит свою же проверку и ложится заметкой к капиталу', () => {
    const plan = importNotes(notesImportSpec.example, data(), ctx)
    expect(plan.issues).toEqual([])
    expect(plan.writes.notes).toMatchObject([{ about: 'capital', date: '2026-09-01' }])
  })

  it('та же заметка на ту же дату второй раз не заводится', () => {
    const first = importNotes(notesImportSpec.example, data(), ctx)
    const again = importNotes(notesImportSpec.example, data([], first.writes.notes ?? []), ctx)
    expect(again.writes.notes).toEqual([])
    expect(again.skipped).toBe(1)
  })

  it('без текста или без даты — отказ', () => {
    const plan = importNotes([{ date: '2026-09-01' }, { text: 'что-то' }], data(), ctx)
    expect(plan.issues.map((each) => each.reason)).toEqual(['нет текста ("text")', 'нет даты ("date")'])
  })
})

describe('промпт', () => {
  it('знает счета, на которые ложатся снимки, — без счёта истории', () => {
    const [balances] = capitalSpecs({ accounts })
    expect(balances?.about).toContain('«Кошелёк» (BTC, сбережения)')
    expect(balances?.about).not.toContain('Таблица (история)')
  })
})
