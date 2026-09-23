import { describe, expect, it } from 'vitest'
import type { Account, Category, Currency } from '../../app/model.ts'
import {
  accountProblem,
  active,
  activeCategories,
  archived,
  categoryProblem,
  cleanName,
  createAccount,
  createCategory,
  createCurrency,
  perMajorOf,
  unitFromPerMajor,
  currencyDraftProblem,
  findByName,
  importableAccounts,
  moved,
  nameProblem,
  nextOrder,
  setArchived,
  sorted,
  updateAccount,
  updateCategory,
} from './ledger.ts'

/**
 * Названия банков в примерах выдуманы: код публичный, а по списку счетов
 * видно, где человек держит деньги (CLAUDE.md, «Личные данные»).
 */
const AT = '2026-09-20T10:00:00.000Z'

function currency(code: string, decimals = 2): Currency {
  return { id: `cur-${code}`, updatedAt: AT, code, name: code, decimals, order: 0 }
}

function account(fields: Partial<Account> & { id: string; name: string }): Account {
  return { updatedAt: AT, currency: 'RUB', kind: 'savings', order: 0, ...fields }
}

function category(fields: Partial<Category> & { id: string; name: string }): Category {
  return { updatedAt: AT, side: 'expense', order: 0, ...fields }
}

const RUB = [currency('RUB')]

describe('названия', () => {
  it('убирает пробелы по краям и двойные внутри', () => {
    expect(cleanName('  Синий   банк  ')).toBe('Синий банк')
  })

  it('находит по названию без учёта регистра и краёв — правилом ядра', () => {
    const list = [account({ id: 'a', name: 'Синий банк' })]
    expect(findByName(list, '  синий БАНК ')?.id).toBe('a')
  })

  it('надгробие названием не занимает: удалённое имя свободно', () => {
    const list = [account({ id: 'a', name: 'Синий банк', deleted: true })]
    expect(findByName(list, 'Синий банк')).toBeUndefined()
    expect(nameProblem(list, 'Синий банк')).toBeNull()
  })

  it('различает пустое, двойника и двойника в архиве', () => {
    const list = [
      account({ id: 'a', name: 'Синий банк' }),
      account({ id: 'b', name: 'Наличные', archived: true }),
    ]
    expect(nameProblem(list, '   ')).toBe('empty')
    expect(nameProblem(list, 'синий банк')).toBe('duplicate')
    expect(nameProblem(list, 'наличные')).toBe('archived')
  })

  it('при переименовании своё прежнее название не мешает', () => {
    const list = [account({ id: 'a', name: 'Синий банк' })]
    expect(nameProblem(list, 'Синий Банк', 'a')).toBeNull()
  })
})

describe('порядок и архив', () => {
  const list = [
    account({ id: 'b', name: 'Второй', order: 1 }),
    account({ id: 'a', name: 'Первый', order: 0 }),
    account({ id: 'c', name: 'Архивный', order: 2, archived: true }),
    account({ id: 'd', name: 'Удалённый', order: 3, deleted: true }),
  ]

  it('живые идут по порядку, удалённые не идут вовсе', () => {
    expect(sorted(list).map((each) => each.id)).toEqual(['a', 'b', 'c'])
  })

  it('архив отделён от того, чем пользуются сейчас', () => {
    expect(active(list).map((each) => each.id)).toEqual(['a', 'b'])
    expect(archived(list).map((each) => each.id)).toEqual(['c'])
  })

  it('новая запись встаёт в конец, а не в середину чужого порядка', () => {
    expect(nextOrder(list)).toBe(3)
    expect(nextOrder([])).toBe(0)
  })

  it('возврат из архива снимает пометку, а не ставит её в false', () => {
    const back = setArchived(account({ id: 'c', name: 'Архивный', archived: true }), false)
    expect('archived' in back).toBe(false)
  })

  it('перестановка пишет две записи, а не перенумеровывает список', () => {
    const two = moved(list, 'b', -1)
    expect(two.map((each) => [each.id, each.order])).toEqual([
      ['b', 0],
      ['a', 1],
    ])
  })

  it('двигать некуда — писать нечего', () => {
    expect(moved(list, 'a', -1)).toEqual([])
  })
})

describe('валюты', () => {
  it('код занят — вторую такую не заводим', () => {
    expect(currencyDraftProblem(RUB, { code: 'rub', name: 'Рубль', decimals: 2 })).toBe('валюта RUB уже заведена')
  })

  it('код приводится к верхнему регистру, название чистится', () => {
    const made = createCurrency([], { code: ' usdt ', name: '  Тезер ', decimals: 4 })
    expect(made.code).toBe('USDT')
    expect(made.name).toBe('Тезер')
  })

  it('знаков больше восьми не бывает — дальше не хватит точности чисел', () => {
    expect(currencyDraftProblem([], { code: 'XXX', name: 'Что-то', decimals: 9 })).toContain('от 0 до 8')
  })

  it('без кода и без названия не заводится', () => {
    expect(currencyDraftProblem([], { code: '', name: 'Рубль', decimals: 2 })).toBe('у валюты нет кода')
    expect(currencyDraftProblem([], { code: 'RUB', name: ' ', decimals: 2 })).toBe('у валюты нет названия')
  })
})

describe('счета', () => {
  it('валюты нет в справочнике — счёт не заводится', () => {
    const problem = accountProblem({ accounts: [], currencies: RUB }, { name: 'Кошелёк', currency: 'BTC', kind: 'savings' })
    expect(problem).toBe('валюты BTC нет в справочнике')
  })

  it('двойник в архиве — вернуть, а не заводить второй', () => {
    const accounts = [account({ id: 'a', name: 'Наличные', archived: true })]
    const problem = accountProblem({ accounts, currencies: RUB }, { name: 'наличные', currency: 'RUB', kind: 'savings' })
    expect(problem).toContain('в архиве')
  })

  it('счёт истории не годится для загрузки выписок (Р-12)', () => {
    const accounts = [
      account({ id: 'a', name: 'Синий банк' }),
      account({ id: 'b', name: 'Таблица', ledgerOnly: true }),
      account({ id: 'c', name: 'Старый банк', archived: true }),
    ]
    expect(importableAccounts(accounts).map((each) => each.id)).toEqual(['a'])
  })

  it('правка счёта не выносит его из архива молча', () => {
    const was = account({ id: 'a', name: 'Старый банк', archived: true })
    const now = updateAccount(was, { name: 'Синий банк', currency: 'RUB', kind: 'savings' })
    expect(now.archived).toBe(true)
    expect(now.name).toBe('Синий банк')
    expect(now.id).toBe('a')
  })

  it('ledgerOnly не пишется ложью: его либо нет, либо true', () => {
    const made = createAccount([], { name: 'Синий банк', currency: 'RUB', kind: 'savings' })
    expect('ledgerOnly' in made).toBe(false)
  })
})

describe('категории', () => {
  it('одноимённые в разных сторонах законны: «Подарки» бывают и расходом, и доходом', () => {
    const list = [category({ id: 'a', name: 'Подарки', side: 'expense' })]
    expect(categoryProblem(list, { name: 'Подарки', side: 'income' })).toBeNull()
    expect(categoryProblem(list, { name: 'подарки', side: 'expense' })).toContain('уже есть')
  })

  it('порядок считается внутри своей стороны', () => {
    const list = [
      category({ id: 'a', name: 'Еда', side: 'expense', order: 0 }),
      category({ id: 'b', name: 'Транспорт', side: 'expense', order: 1 }),
    ]
    expect(createCategory(list, { name: 'Зарплата', side: 'income' }).order).toBe(0)
    expect(createCategory(list, { name: 'Связь', side: 'expense' }).order).toBe(2)
  })

  it('в выбор идут только живые категории своей стороны', () => {
    const list = [
      category({ id: 'a', name: 'Еда', side: 'expense' }),
      category({ id: 'b', name: 'Зарплата', side: 'income' }),
      category({ id: 'c', name: 'Старое', side: 'expense', archived: true }),
    ]
    expect(activeCategories(list, 'expense').map((each) => each.id)).toEqual(['a'])
    expect(activeCategories(list, 'income').map((each) => each.id)).toEqual(['b'])
  })

  it('перенос категории в другую сторону сохраняет id: история к ней привязана', () => {
    const was = category({ id: 'a', name: 'Подарки', side: 'expense' })
    const now = updateCategory(was, { name: 'Подарки', side: 'income' })
    expect(now.id).toBe('a')
    expect(now.side).toBe('income')
  })
})

describe('единица показа — словами человека', () => {
  it('«в одном BTC — 1000 mBTC» даёт множитель в сатоши', () => {
    expect(unitFromPerMajor(8, 'mBTC', 1000)).toEqual({ unit: { name: 'mBTC', factor: 100000 } })
  })

  it('без имени единицы нет — и это не ошибка', () => {
    expect(unitFromPerMajor(8, '  ', 1000)).toEqual({ unit: null })
  })

  it('единица мельче минимальной или делящая её не нацело — отказ', () => {
    expect(unitFromPerMajor(2, 'мкр', 1000)).toHaveProperty('problem')
    expect(unitFromPerMajor(8, 'треть', 3)).toHaveProperty('problem')
    expect(unitFromPerMajor(8, 'mBTC', 0)).toHaveProperty('problem')
  })

  it('обратно в поле формы: у mBTC — 1000, без единицы — пусто', () => {
    const btc: Currency = { id: 'b', updatedAt: '', code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 }, order: 0 }
    expect(perMajorOf(btc)).toBe(1000)
    expect(perMajorOf({ ...btc, unit: undefined })).toBeNull()
  })
})
