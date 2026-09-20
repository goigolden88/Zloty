import { describe, expect, it } from 'vitest'
import type { Account, Category, Currency, Entry } from '../../app/model.ts'
import { filterFeed, groupFeed } from '../../shared/core/feed.ts'
import { entryFeed, entryMarkdown, ENTRY_KIND, type FeedData } from './feed.ts'

/** Описания и суммы выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'

const RUB: Currency = { id: 'c', updatedAt: AT, code: 'RUB', name: 'Рубль', decimals: 2, order: 0 }
const BANK: Account = { id: 'acc-1', updatedAt: AT, name: 'Синий банк', currency: 'RUB', kind: 'savings', order: 0 }
const CASH: Account = { id: 'acc-2', updatedAt: AT, name: 'Наличные', currency: 'RUB', kind: 'savings', order: 1 }
const FOOD: Category = { id: 'cat', updatedAt: AT, name: 'Продукты', side: 'expense', order: 0 }

function entry(fields: Partial<Entry> = {}): Entry {
  return {
    id: 'e-1',
    updatedAt: AT,
    kind: 'expense',
    accountId: BANK.id,
    money: { amount: 34990, currency: 'RUB' },
    date: '2026-09-14',
    categoryId: FOOD.id,
    ...fields,
  }
}

function data(entries: Entry[]): FeedData {
  return { entries, accounts: [BANK, CASH], categories: [FOOD], currencies: [RUB] }
}

describe('строки ленты', () => {
  it('сумма — заголовок, вид и счёт — строкой под ней', () => {
    const [item] = entryFeed(data([entry()]))
    expect(item?.kind).toBe(ENTRY_KIND)
    expect(item?.title).toContain('349,90')
    expect(item?.detail).toContain('расход')
    expect(item?.detail).toContain('Синий банк')
    expect(item?.detail).toContain('Продукты')
  })

  it('надгробия в ленту не идут', () => {
    expect(entryFeed(data([entry({ deleted: true })]))).toHaveLength(0)
  })

  it('перевод без второго счёта так и говорит', () => {
    const [item] = entryFeed(data([entry({ kind: 'transfer', categoryId: undefined })]))
    expect(item?.detail).toContain('второй счёт не указан')
  })

  it('перевод со вторым счётом показывает, куда', () => {
    const move = entry({ kind: 'transfer', categoryId: undefined, toAccountId: CASH.id })
    expect(entryFeed(data([move]))[0]?.detail).toContain('→ Наличные')
  })

  it('итог периода стоит по концу периода и называет его', () => {
    const total = entry({ date: undefined, categoryId: undefined, period: { from: '2026-01-05', to: '2026-02-14' } })
    const [item] = entryFeed(data([total]))
    expect(item?.date).toBe('2026-02-14')
    expect(item?.detail).toContain('итог за')
    expect(item?.detail).toContain('по категориям не разложено')
  })

  it('удалённый счёт не роняет строку, а называется', () => {
    const orphan = entry({ accountId: 'нет такого' })
    expect(entryFeed(data([orphan]))[0]?.detail).toContain('счёт удалён')
  })
})

describe('поиск по истории', () => {
  const list = [
    entry({ id: 'a', bankText: 'МАГАЗИН У ДОМА 349.90' }),
    entry({ id: 'b', date: '2026-08-03', money: { amount: 120000, currency: 'RUB' }, note: 'страховка на год' }),
  ]

  it('находит по банковскому описанию, которого на экране нет', () => {
    const found = filterFeed(entryFeed(data(list)), { query: 'магазин' })
    expect(found.map((each) => each.id)).toEqual(['a'])
  })

  it('находит по заметке', () => {
    const found = filterFeed(entryFeed(data(list)), { query: 'страховка' })
    expect(found.map((each) => each.id)).toEqual(['b'])
  })

  it('находит по дате словами — это правило ядра', () => {
    const found = filterFeed(entryFeed(data(list)), { query: 'август' })
    expect(found.map((each) => each.id)).toEqual(['b'])
  })

  it('разбивается по месяцам, новые сверху', () => {
    const groups = groupFeed(entryFeed(data(list)))
    expect(groups.map((each) => each.month)).toEqual(['2026-09', '2026-08'])
  })
})

describe('markdown', () => {
  const list = [entry({ id: 'a' }), entry({ id: 'b', date: '2026-08-03' })]

  it('за всё время — все записи, новые сверху', () => {
    const text = entryMarkdown(data(list), null)
    expect(text.split('\n')).toHaveLength(2)
    expect(text.indexOf('14.09')).toBeLessThan(text.indexOf('03.08'))
  })

  it('за период — только его записи', () => {
    const text = entryMarkdown(data(list), { from: '2026-09-01', to: '2026-09-30' })
    expect(text).toContain('14.09')
    expect(text).not.toContain('03.08')
  })

  it('пусто — так и сказано, а не пустая строка', () => {
    expect(entryMarkdown(data([]), null)).toContain('Записей нет')
  })

  it('служебные знаки в заметке экранируются: заметка не станет курсивом', () => {
    const tricky = entry({ note: '*важно* купить' })
    expect(entryMarkdown(data([tricky]), null)).not.toContain('*важно*')
  })
})
