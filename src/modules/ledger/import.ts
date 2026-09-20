/**
 * Разделы импорта учёта (Р-08, Р-09): `currencies`, `accounts`,
 * `categories`, `rates`, `entries`.
 *
 * Единственная дверь в данные извне. Чистые функции: сырой раздел и то, что
 * уже есть в базе, на входе, записи к добавлению — на выходе; в базу не
 * пишет никто из них. Разделы разбираются по порядку, и каждый видит
 * заведённое предыдущими (02-Архитектура, «Импорт»).
 *
 * Что здесь важно и почему:
 *
 * — **`ext` пишется один раз и не меняется** (Р-12, п. 4). Он же ловит
 *   повтор: та же выписка, загруженная второй раз, даёт те же ключи, и все
 *   записи пропускаются. Номер среди одинаковых за день считается по месту
 *   в файле, а не по тому, сколько их уже в базе, — иначе повторная загрузка
 *   выдала бы новые номера и записала дубли.
 * — **Счёт наугад не заводится.** Валюты у операции нет — она в валюте
 *   счёта, — и выдумать её нельзя. Счёт, которого нет в справочнике,
 *   называется с причиной; завести его умеет раздел `accounts`, где валюта
 *   сказана явно. Категория заводится: у неё выдумывать нечего.
 * — **Встречные стороны перевода склеиваются внутри одного файла** (Р-12,
 *   п. 3) — и только между записями, помеченными переводом. Несклеенное
 *   остаётся отдельной записью и называется числом, а не исчезает.
 * — **Примеры выдуманные:** промпт уезжает к тому, с кем идёт беседа.
 */

import { daysBetween, formatDate, plural } from '../../shared/core/dates.ts'
import {
  absent,
  dayOf,
  dayOrMonthOf,
  numberOf,
  recordsOf,
  shown,
  textOf,
  type ImportContext,
  type ImportPlan,
  type ImportSpec,
} from '../../shared/core/importing.ts'
import type { Account, Category, Currency, Entry, Rate, StoreRecord } from '../../app/model.ts'
import { findCurrency, formatMoney, parseAmount, suggestDecimals } from '../money/money.ts'
import { createAccount, createCategory, createCurrency, findByName, sortedCurrencies } from './ledger.ts'

/** Насколько далеко расходятся даты у двух сторон одного перевода (Р-12, п. 3). */
export const TRANSFER_MATCH_DAYS = 3

type Plan = ImportPlan<StoreRecord>

/** Что разделам нужно из базы. С надгробиями: по ним видно, какие id заняты. */
export type LedgerImportData = {
  currencies: readonly Currency[]
  accounts: readonly Account[]
  categories: readonly Category[]
  entries: readonly Entry[]
  rates: readonly Rate[]
}

const FORMS = {
  currency: ['валюта', 'валюты', 'валют'] as [string, string, string],
  account: ['счёт', 'счёта', 'счетов'] as [string, string, string],
  category: ['категория', 'категории', 'категорий'] as [string, string, string],
  entry: ['запись', 'записи', 'записей'] as [string, string, string],
  rate: ['курс', 'курса', 'курсов'] as [string, string, string],
}

// ─── Валюты ────────────────────────────────────────────────────────────────

export const currenciesImportSpec: ImportSpec = {
  section: 'currencies',
  about:
    'валюты, в которых ведутся счета. Пиши только те, которых может не быть в приложении, — их список ' +
    'дан ниже. Одна запись — одна валюта.',
  fields: [
    '"code" — код: RUB, USD, USDT, BTC. Обязательно',
    '"name" — название по-русски: «Рубль», «Биткойн». Обязательно',
    '"decimals" — сколько знаков после запятой: 2 у рубля, 8 у биткойна. Не знаешь — не пиши',
  ],
  example: [
    { code: 'USD', name: 'Доллар', decimals: 2 },
    { code: 'USDT', name: 'Тезер', decimals: 4 },
  ],
}

export function importCurrencies(raw: unknown, data: LedgerImportData, ctx: ImportContext): Plan {
  const section = currenciesImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const known = [...data.currencies]
  const created: Currency[] = []
  let skipped = 0

  for (const { raw: record, index } of records) {
    const code = textOf(record.code)?.toUpperCase()
    if (!code) {
      issues.push({ section, title: `валюта ${index + 1}`, reason: 'нет кода ("code")' })
      continue
    }
    if (known.some((each) => !each.deleted && each.code === code)) {
      skipped += 1
      continue
    }

    const name = textOf(record.name) ?? code
    const decimals = absent(record.decimals) ? suggestDecimals(code) : numberOf(record.decimals)
    if (decimals === null || !Number.isInteger(decimals)) {
      issues.push({ section, title: code, reason: `знаков после запятой «${shown(record.decimals)}» — не целое число` })
      continue
    }

    const currency = { ...createCurrency(known, { code, name, decimals }), id: ctx.newId(), updatedAt: ctx.now }
    known.push(currency)
    created.push(currency)
  }

  return {
    writes: { currencies: created },
    added: [{ count: created.length, forms: FORMS.currency }].filter((each) => each.count > 0),
    skipped,
    issues,
  }
}

// ─── Счета ─────────────────────────────────────────────────────────────────

export const accountsImportSpec: ImportSpec = {
  section: 'accounts',
  about:
    'счета — где лежат деньги. Счёт это банк целиком, а не отдельная карта или вклад. Пиши сюда только ' +
    'те счета, которых нет в списке ниже; существующие не повторяй.',
  fields: [
    '"name" — название: банк, «Наличные». Обязательно',
    '"currency" — код валюты счёта. Обязательно',
    '"kind" — "savings" для денег, которыми пользуются, "investment" для вложений. Не знаешь — не пиши',
    '"ledgerOnly" — true только для счёта, на который переносится история прежней таблицы. ' +
      'Выписки на такой счёт не загружаются никогда. Не уверен — не пиши',
  ],
  example: [{ name: 'Наличные', currency: 'RUB', kind: 'savings' }],
}

export function importAccounts(raw: unknown, data: LedgerImportData, ctx: ImportContext): Plan {
  const section = accountsImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const known = [...data.accounts]
  const currencies = [...data.currencies]
  const created: Account[] = []
  let skipped = 0

  for (const { raw: record, index } of records) {
    const name = textOf(record.name)
    if (!name) {
      issues.push({ section, title: `счёт ${index + 1}`, reason: 'нет названия ("name")' })
      continue
    }
    if (findByName(known, name)) {
      skipped += 1
      continue
    }

    const currency = textOf(record.currency)?.toUpperCase()
    if (!currency) {
      issues.push({ section, title: name, reason: 'нет валюты ("currency") — выдумать её нельзя' })
      continue
    }
    if (!currencies.some((each) => !each.deleted && each.code === currency)) {
      issues.push({ section, title: name, reason: `валюты ${currency} нет в справочнике — добавьте её в раздел «currencies»` })
      continue
    }

    const kind = textOf(record.kind) === 'investment' ? 'investment' : 'savings'
    // Счёт истории заводится тем же файлом, которым переносится история
    // (Р-12, п. 6): иначе перенос требует руки до файла и перестаёт быть
    // воспроизводимым одним действием.
    const ledgerOnly = record.ledgerOnly === true
    const account = {
      ...createAccount(known, { name, currency, kind, ledgerOnly }),
      id: ctx.newId(),
      updatedAt: ctx.now,
    }
    known.push(account)
    created.push(account)
  }

  return {
    writes: { accounts: created },
    added: [{ count: created.length, forms: FORMS.account }].filter((each) => each.count > 0),
    skipped,
    issues,
  }
}

// ─── Категории ─────────────────────────────────────────────────────────────

export const categoriesImportSpec: ImportSpec = {
  section: 'categories',
  about:
    'категории — на что потрачено и откуда пришло. Расходные и доходные — разные: у одной и той же ' +
    'записи сторона своя. Кэшбэк и возврат покупки — доход, а не уменьшение расхода.',
  fields: [
    '"name" — название. Обязательно',
    '"side" — "expense" для расходной, "income" для доходной. Обязательно',
  ],
  example: [
    { name: 'Продукты', side: 'expense' },
    { name: 'Кэшбэк', side: 'income' },
  ],
}

export function importCategories(raw: unknown, data: LedgerImportData, ctx: ImportContext): Plan {
  const section = categoriesImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const known = [...data.categories]
  const created: Category[] = []
  let skipped = 0

  for (const { raw: record, index } of records) {
    const name = textOf(record.name)
    if (!name) {
      issues.push({ section, title: `категория ${index + 1}`, reason: 'нет названия ("name")' })
      continue
    }
    const side = sideOf(record.side)
    if (!side) {
      issues.push({ section, title: name, reason: `сторона «${shown(record.side)}» — не "expense" и не "income"` })
      continue
    }
    if (findByName(known.filter((each) => each.side === side), name)) {
      skipped += 1
      continue
    }

    const category = { ...createCategory(known, { name, side }), id: ctx.newId(), updatedAt: ctx.now }
    known.push(category)
    created.push(category)
  }

  return {
    writes: { categories: created },
    added: [{ count: created.length, forms: FORMS.category }].filter((each) => each.count > 0),
    skipped,
    issues,
  }
}

function sideOf(value: unknown): Category['side'] | null {
  const text = textOf(value)?.toLocaleLowerCase('ru')
  if (text === 'expense' || text === 'расход') return 'expense'
  if (text === 'income' || text === 'доход') return 'income'
  return null
}

// ─── Курсы ─────────────────────────────────────────────────────────────────

export const ratesImportSpec: ImportSpec = {
  section: 'rates',
  about: 'курсы валют на дату: 1 единица «from» равна «rate» единиц «to». Пиши, только если курс есть в данных.',
  fields: [
    '"date" — дата курса, ГГГГ-ММ-ДД. Обязательно',
    '"from" — код валюты, которую переводим. Обязательно',
    '"to" — код валюты, в которую переводим. Обязательно',
    '"rate" — сколько «to» за одну «from», числом. Дробное — можно. Обязательно',
  ],
  example: [{ date: '2026-09-15', from: 'USD', to: 'RUB', rate: 81.42 }],
}

export function importRates(raw: unknown, data: LedgerImportData, ctx: ImportContext): Plan {
  const section = ratesImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const known = [...data.rates]
  const created: Rate[] = []
  let skipped = 0

  for (const { raw: record, index } of records) {
    const date = dayOf(record.date)
    const from = textOf(record.from)?.toUpperCase()
    const to = textOf(record.to)?.toUpperCase()
    const rate = numberOf(record.rate)
    const title = `курс ${index + 1}`

    if (!date) {
      issues.push({ section, title, reason: `дата «${shown(record.date)}» — не ГГГГ-ММ-ДД` })
      continue
    }
    if (!from || !to) {
      issues.push({ section, title, reason: 'нет валюты ("from" или "to")' })
      continue
    }
    if (rate === null || !(rate > 0)) {
      issues.push({ section, title, reason: `курс «${shown(record.rate)}» — не число больше нуля` })
      continue
    }
    // Естественный ключ курса — дата и пара валют: тот же курс, пришедший
    // второй раз, не заводит вторую запись.
    if (known.some((each) => !each.deleted && each.date === date && each.from === from && each.to === to)) {
      skipped += 1
      continue
    }

    const made: Rate = { id: ctx.newId(), updatedAt: ctx.now, date, from, to, rate, source: 'import' }
    known.push(made)
    created.push(made)
  }

  return {
    writes: { rates: created },
    added: [{ count: created.length, forms: FORMS.rate }].filter((each) => each.count > 0),
    skipped,
    issues,
  }
}

// ─── Записи учёта ──────────────────────────────────────────────────────────

export const entriesImportSpec: ImportSpec = {
  section: 'entries',
  about:
    'операции выписки и итоги периодов. Одна строка выписки — одна запись. Перевод между двумя моими ' +
    'счетами — одна запись "transfer", а не две. Движения внутри одного счёта (с карты на накопительный ' +
    'того же банка) не пиши вовсе: они ничего не меняют.',
  fields: [
    '"kind" — "expense" расход, "income" доход, "transfer" перевод между моими счетами. Обязательно. ' +
      'Знак в выписке говорит направление; кэшбэк и возврат покупки — это "income"',
    '"account" — название счёта из списка ниже. Обязательно',
    '"amount" — сумма в обычных единицах, положительная, без знака: 1234.56. Обязательно',
    '"date" — дата операции, ГГГГ-ММ-ДД. Обязательна, кроме итога за период',
    '"time" — время, ЧЧ:ММ, если оно есть в выписке. Оно помогает отличить две одинаковые операции',
    '"category" — название категории; у "transfer" её не бывает. Недостающая заведётся',
    '"toAccount" — второй мой счёт у перевода, если он понятен из описания',
    '"special" — true, если трата особая: техника, поездка, лечение. Не уверен — не пиши',
    '"for" — ГГГГ-ММ, если платёж за другой месяц: «интернет за август»',
    '"bankText" — строка выписки как есть. Пиши её всегда: по ней потом видно, что это было',
    '"bankId" — код операции из выписки, если банк его даёт',
    '"note" — что стоит запомнить: например, что операция была в другой валюте',
    '"periodFrom" и "periodTo" — вместо "date", если это итог за период целиком, без отдельных операций',
  ],
  example: [
    {
      kind: 'expense',
      account: 'Синий банк',
      amount: 349.9,
      date: '2026-09-14',
      time: '12:05',
      category: 'Продукты',
      bankText: 'ПЯТЁРОЧКА 349.90 RUB',
    },
    {
      kind: 'transfer',
      account: 'Синий банк',
      toAccount: 'Наличные',
      amount: 5000,
      date: '2026-09-15',
      bankText: 'Снятие наличных',
    },
  ],
}

/** Одна разобранная строка — до того, как ей назначен ключ. */
type Draft = {
  entry: Entry
  /** Ключ без номера среди одинаковых. Пусто — у записи есть код банка. */
  base: string | null
  /** Готовый ключ, если банк дал свой код. */
  exact: string | null
}

export function importEntries(raw: unknown, data: LedgerImportData, ctx: ImportContext): Plan {
  const section = entriesImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const issue = (title: string, reason: string) => issues.push({ section, title, reason })

  const categories = [...data.categories]
  const createdCategories: Category[] = []
  let skipped = 0
  let rounded = 0

  const drafts: Draft[] = []

  for (const { raw: record, index } of records) {
    const title = textOf(record.bankText) ?? `запись ${index + 1}`

    const kind = kindOf(record.kind)
    if (!kind) {
      issue(title, `вид «${shown(record.kind)}» — не "expense", "income" или "transfer"`)
      continue
    }

    const accountName = textOf(record.account)
    const account = accountName ? findByName(data.accounts, accountName) : null
    if (!account) {
      issue(title, accountName ? `счёта «${accountName}» нет — заведите его или добавьте в раздел «accounts»` : 'нет счёта ("account")')
      continue
    }

    const currency = data.currencies.find((each) => !each.deleted && each.code === account.currency)
    if (!currency) {
      issue(title, `валюты ${account.currency} нет в справочнике`)
      continue
    }

    const parsed = absent(record.amount) ? null : parseAmount(String(record.amount), currency.decimals)
    if (!parsed || parsed.amount === 0) {
      issue(title, `сумма «${shown(record.amount)}» — не положительное число`)
      continue
    }
    if (parsed.rounded) rounded += 1

    const when = whenOf(record)
    if ('problem' in when) {
      issue(title, when.problem)
      continue
    }

    const entry: Entry = {
      id: ctx.newId(),
      updatedAt: ctx.now,
      kind,
      accountId: account.id,
      money: { amount: parsed.amount, currency: account.currency },
    }
    if (when.date) entry.date = when.date
    if (when.period) entry.period = when.period

    const time = timeOf(record.time)
    if (time) entry.time = time

    if (kind !== 'transfer') {
      const name = textOf(record.category)
      if (name) {
        const side = kind === 'income' ? 'income' : 'expense'
        const known = findByName(categories.filter((each) => each.side === side), name)
        if (known) {
          entry.categoryId = known.id
        } else {
          const made = { ...createCategory(categories, { name, side }), id: ctx.newId(), updatedAt: ctx.now }
          categories.push(made)
          createdCategories.push(made)
          entry.categoryId = made.id
        }
      } else if (!entry.period) {
        issue(title, 'нет категории ("category")')
        continue
      }
    }

    if (kind === 'transfer') {
      const toName = textOf(record.toAccount)
      const to = toName ? findByName(data.accounts, toName) : null
      if (to && to.id !== account.id) entry.toAccountId = to.id
      if (to && to.id === account.id) {
        issue(title, 'перевод внутри одного счёта не записывается: остатка он не меняет')
        continue
      }
    }

    if (record.special === true && kind === 'expense') entry.special = true

    // Итог за период не ложится туда, где уже есть операции той же природы
    // (Р-02, Р-14). Ручной ввод это проверяет, и импорт обязан тоже: без
    // проверки расход посчитался бы дважды — и молча.
    const covered = entry.period ? operationsInside(data.entries, entry) : null
    if (covered) {
      issue(
        title,
        `на счёте «${account.name}» внутри этого периода уже есть операции (например, за ` +
          `${formatDate(covered.date ?? '')}). На один счёт в одном периоде — либо итог, либо операции`,
      )
      continue
    }

    const forMonth = dayOrMonthOf(record.for)
    if (forMonth && /^\d{4}-\d{2}$/.test(forMonth)) entry.for = forMonth
    const bankText = textOf(record.bankText)
    if (bankText) entry.bankText = bankText
    const note = textOf(record.note)
    if (note) entry.note = note

    const bankId = textOf(record.bankId)
    drafts.push({
      entry,
      base: bankId ? null : baseKey(account.id, entry),
      exact: bankId ? `${account.id}:${bankId}` : null,
    })
  }

  const { kept, merged } = mergeTransfers(drafts)

  // Номер среди одинаковых считается по месту в файле, а не по базе: иначе
  // та же выписка, загруженная второй раз, получила бы новые номера (Р-12).
  const seen = new Map<string, number>()
  const existing = new Set(data.entries.filter((each) => each.ext).map((each) => each.ext as string))
  const created: Entry[] = []

  for (const draft of kept) {
    let ext = draft.exact
    if (ext === null && draft.base !== null) {
      const at = seen.get(draft.base) ?? 0
      seen.set(draft.base, at + 1)
      ext = `${draft.base}:${at}`
    }
    if (ext === null) continue

    if (existing.has(ext)) {
      skipped += 1
      continue
    }
    existing.add(ext)
    created.push({ ...draft.entry, ext })
  }

  if (rounded > 0) {
    issues.push({
      section,
      title: 'округление',
      reason: `у ${rounded} ${plural(rounded, FORMS.entry)} было больше знаков после запятой, чем у валюты счёта — сумма округлена`,
    })
  }
  if (merged > 0) {
    issues.push({
      section,
      title: 'переводы',
      reason: `склеено встречных сторон перевода: ${merged}. Несклеенные остались отдельными записями`,
    })
  }

  const added = [
    { count: created.length, forms: FORMS.entry },
    { count: createdCategories.length, forms: FORMS.category },
  ].filter((each) => each.count > 0)

  return { writes: { entries: created, categories: createdCategories }, added, skipped, issues }
}

function kindOf(value: unknown): Entry['kind'] | null {
  const text = textOf(value)?.toLocaleLowerCase('ru')
  if (text === 'expense' || text === 'расход') return 'expense'
  if (text === 'income' || text === 'доход') return 'income'
  if (text === 'transfer' || text === 'перевод') return 'transfer'
  return null
}

const TIME = /^(\d{1,2}):(\d{2})$/

function timeOf(value: unknown): string | null {
  const match = TIME.exec(textOf(value) ?? '')
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${match[2]}`
}

type When = { date?: string; period?: { from: string; to: string } } | { problem: string }

function whenOf(record: Record<string, unknown>): When {
  const from = dayOf(record.periodFrom)
  const to = dayOf(record.periodTo)
  if (!absent(record.periodFrom) || !absent(record.periodTo)) {
    if (!from || !to) return { problem: 'у итога периода нужны обе границы: "periodFrom" и "periodTo"' }
    if (from > to) return { problem: 'период кончается раньше, чем начинается' }
    return { period: { from, to } }
  }

  const date = dayOf(record.date)
  if (!date) return { problem: `дата «${shown(record.date)}» — не ГГГГ-ММ-ДД` }
  return { date }
}

/**
 * Операция той же природы внутри периода итога — или null, если её нет.
 *
 * «Той же природы» — тот же счёт, тот же вид и тот же признак «особая»
 * (Р-14): обычный итог и особые операции того же периода говорят о разном.
 */
function operationsInside(entries: readonly Entry[], total: Entry): Entry | null {
  const period = total.period
  if (!period) return null
  return (
    entries.find(
      (each) =>
        !each.deleted &&
        !each.period &&
        each.accountId === total.accountId &&
        each.kind === total.kind &&
        Boolean(each.special) === Boolean(total.special) &&
        each.date !== undefined &&
        each.date >= period.from &&
        each.date <= period.to,
    ) ?? null
  )
}

/**
 * Ключ строки без номера среди одинаковых: счёт, дата, время, сумма и
 * описание без лишних пробелов и регистра (Р-12, п. 4).
 */
function baseKey(accountId: string, entry: Entry): string {
  const day = entry.date ?? entry.period?.to ?? ''
  const text = (entry.bankText ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru')
  return [accountId, day, entry.time ?? '', String(entry.money.amount), text].join(':')
}

/**
 * Встречные стороны одного перевода — в одну запись (Р-12, п. 3).
 *
 * Склеиваются только записи, обе помеченные переводом, с одинаковой суммой,
 * на разных счетах и с датами не дальше `TRANSFER_MATCH_DAYS` друг от друга.
 * Всё остальное остаётся как есть: склейка, которая ошиблась, съела бы
 * настоящий доход.
 */
function mergeTransfers(drafts: readonly Draft[]): { kept: Draft[]; merged: number } {
  const kept: Draft[] = []
  const used = new Set<number>()
  let merged = 0

  drafts.forEach((draft, at) => {
    if (used.has(at)) return
    const one = draft.entry
    if (one.kind !== 'transfer' || !one.date) {
      kept.push(draft)
      return
    }

    const pair = drafts.findIndex((other, index) => {
      if (index <= at || used.has(index)) return false
      const two = other.entry
      return (
        two.kind === 'transfer' &&
        Boolean(two.date) &&
        two.accountId !== one.accountId &&
        two.money.amount === one.money.amount &&
        two.money.currency === one.money.currency &&
        Math.abs(daysBetween(one.date ?? '', two.date ?? '')) <= TRANSFER_MATCH_DAYS
      )
    })

    if (pair === -1) {
      kept.push(draft)
      return
    }

    used.add(pair)
    merged += 1
    const other = drafts[pair]
    kept.push({
      ...draft,
      entry: { ...one, toAccountId: one.toAccountId ?? other?.entry.accountId },
    })
  })

  return { kept, merged }
}

// ─── Промпт ────────────────────────────────────────────────────────────────

/**
 * Что приложение знает и говорит беседе: свои справочники, то, как уже
 * разложены самые частые описания, и по каждому счёту — дату последней
 * операции (Р-12, пп. 5, 8).
 */
export function ledgerPromptNotes(data: LedgerImportData, lastDays: Map<string, string | null>): string {
  const lines: string[] = []

  const currencies = sortedCurrencies(data.currencies).map((each) => each.code)
  if (currencies.length > 0) lines.push(`Валюты, которые уже есть: ${currencies.join(', ')}.`)

  const accounts = data.accounts.filter((each) => !each.deleted && !each.archived && !each.ledgerOnly)
  if (accounts.length > 0) {
    lines.push('', 'Мои счета — на них ложатся выписки:')
    for (const account of accounts) {
      const last = lastDays.get(account.id) ?? null
      lines.push(
        `  - «${account.name}» (${account.currency})` +
          (last ? `: операции загружены по ${last} включительно — бери выписку с этого дня, его тоже` : ': операций ещё нет'),
      )
    }
  }

  const expense = data.categories.filter((each) => !each.deleted && !each.archived && each.side === 'expense')
  const income = data.categories.filter((each) => !each.deleted && !each.archived && each.side === 'income')
  if (expense.length > 0) lines.push('', `Расходные категории: ${expense.map((each) => each.name).join(', ')}.`)
  if (income.length > 0) lines.push('', `Доходные категории: ${income.map((each) => each.name).join(', ')}.`)

  const samples = promptSamples(data)
  if (samples.length > 0) {
    lines.push('', 'Так я уже раскладывал самые частые описания — держись этого:')
    for (const sample of samples) lines.push(`  - «${sample.text}» → ${sample.category}`)
  }

  if (accounts.length > 1) {
    lines.push(
      '',
      'Если выписок несколько, клади их в один файл: тогда перевод между моими счетами, видный ' +
        'в двух выписках, склеится в одну запись.',
    )
  }

  return lines.join('\n')
}

/** Сколько разобранных описаний показывать беседе. Больше — промпт раздувается, толку не прибавляется. */
export const PROMPT_SAMPLES = 20

type Sample = { text: string; category: string }

/**
 * Самые частые описания выписок с тем, в какую категорию они уже разложены
 * (Р-12, п. 8). Справочника правил не заводится: та же раскладка уже лежит
 * в загруженных операциях.
 */
export function promptSamples(data: LedgerImportData, limit: number = PROMPT_SAMPLES): Sample[] {
  const names = new Map(data.categories.filter((each) => !each.deleted).map((each) => [each.id, each.name]))
  const counts = new Map<string, { text: string; category: string; count: number }>()

  for (const entry of data.entries) {
    if (entry.deleted || !entry.bankText || !entry.categoryId) continue
    const category = names.get(entry.categoryId)
    if (!category) continue
    const key = `${entry.bankText.trim().toLocaleLowerCase('ru')}→${category}`
    const was = counts.get(key)
    if (was) was.count += 1
    else counts.set(key, { text: entry.bankText.trim(), category, count: 1 })
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ru'))
    .slice(0, limit)
    .map(({ text, category }) => ({ text, category }))
}

// ─── Замена итога периода операциями (Р-02) ────────────────────────────────

/**
 * Итог периода, который заменяют пришедшие операции того же счёта.
 *
 * Единственное место, где импорт не только добавляет (02-Архитектура,
 * «Импорт»): операции подробнее итога, и держать оба — считать расход
 * дважды. Итог уходит надгробием, а разница называется.
 */
export type Replaced = { tombstones: Entry[]; notes: string[] }

export function replacedTotals(data: LedgerImportData, incoming: readonly Entry[], now: string): Replaced {
  const tombstones: Entry[] = []
  const notes: string[] = []

  const totals = data.entries.filter((each) => !each.deleted && each.period && each.kind !== 'transfer')

  for (const total of totals) {
    const period = total.period
    if (!period) continue

    // Той же природы, что итог (Р-14): особые операции не заменяют обычный
    // итог, а обычные — особый.
    const covering = incoming.filter(
      (each) =>
        each.accountId === total.accountId &&
        each.kind === total.kind &&
        Boolean(each.special) === Boolean(total.special) &&
        each.date !== undefined &&
        each.date >= period.from &&
        each.date <= period.to,
    )
    if (covering.length === 0) continue

    const sum = covering.reduce((all, each) => all + each.money.amount, 0)
    const difference = sum - total.money.amount
    const currency = findCurrency(data.currencies, total.money.currency)
    const shownDifference = formatMoney({ amount: Math.abs(difference), currency: total.money.currency }, currency)

    tombstones.push({ ...total, deleted: true, updatedAt: now })
    notes.push(
      `итог за ${formatDate(period.from)} — ${formatDate(period.to)} заменён операциями: ` +
        `их ${covering.length}, и они ${difference === 0 ? 'сходятся с итогом' : difference > 0 ? `больше итога на ${shownDifference}` : `меньше итога на ${shownDifference}`}`,
    )
  }

  return { tombstones, notes }
}

/** Все разделы учёта по порядку разбора: справочники раньше записей. */
export const LEDGER_IMPORT_SPECS: readonly ImportSpec[] = [
  currenciesImportSpec,
  accountsImportSpec,
  categoriesImportSpec,
  ratesImportSpec,
  entriesImportSpec,
]

/**
 * Те же разделы, но со справочниками внутри: промпт обязан знать счета,
 * категории и то, по какой день уже загружено (Р-08; Р-12, пп. 5, 8).
 *
 * Правки ядра это не потребовало: `buildPrompt` берёт разделы от приложения,
 * а нигде не сказано, что разделы обязаны быть постоянными. Живое описание
 * кладётся в `about` того раздела, к которому относится, — и попадает
 * в промпт ровно там, где нужно.
 */
export function ledgerSpecs(data: LedgerImportData, lastDays: Map<string, string | null>): ImportSpec[] {
  const notes = ledgerPromptNotes(data, lastDays)
  return LEDGER_IMPORT_SPECS.map((spec) => {
    if (spec.section !== entriesImportSpec.section || !notes) return spec
    return { ...spec, about: [spec.about, '', notes].join('\n') }
  })
}
