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
 * — **Встречные стороны перевода не склеиваются** (Р-19, отменяет Р-12,
 *   п. 3). Одно движение — одна запись, и пишет её беседа: она видит все
 *   выписки сразу, а обе стороны описывают движение одинаково — `account`
 *   откуда, `toAccount` куда. Склейка по догадке съедала настоящие записи.
 * — **Примеры выдуманные:** промпт уезжает к тому, с кем идёт беседа.
 */

import { formatDate, nowIso, plural } from '../../shared/core/dates.ts'
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
  type Issue,
} from '../../shared/core/importing.ts'
import type { Account, Category, Currency, Entry, Rate, Recurring, StoreRecord } from '../../app/model.ts'
import { findCurrency, formatMoney, parseAmount, suggestDecimals } from '../money/money.ts'
import { createAccount, createCategory, createCurrency, findByName, sortedCurrencies } from './ledger.ts'

type Plan = ImportPlan<StoreRecord>

/** Что разделам нужно из базы. С надгробиями: по ним видно, какие id заняты. */
export type LedgerImportData = {
  currencies: readonly Currency[]
  accounts: readonly Account[]
  categories: readonly Category[]
  recurring: readonly Recurring[]
  entries: readonly Entry[]
  rates: readonly Rate[]
}

/** Склонение записей учёта. Вынесено наружу: по нему реестр узнаёт свою строку в сводке. */
export const ENTRY_FORMS: [string, string, string] = ['запись', 'записи', 'записей']

const FORMS = {
  currency: ['валюта', 'валюты', 'валют'] as [string, string, string],
  account: ['счёт', 'счёта', 'счетов'] as [string, string, string],
  category: ['категория', 'категории', 'категорий'] as [string, string, string],
  entry: ENTRY_FORMS,
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
    '"unit" — единица показа, если суммы привычнее видеть в ней: {"name": "mBTC", "factor": 100000}, ' +
      'где "factor" — сколько минимальных единиц в одной единице показа (в mBTC — 100000 сатоши). ' +
      'Суммы в файле всё равно пиши в обычных единицах валюты. Не просили — не пиши',
  ],
  example: [
    { code: 'USD', name: 'Доллар', decimals: 2 },
    { code: 'USDT', name: 'Тезер', decimals: 4 },
    { code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 } },
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

    const unit = unitOf(record.unit)
    if (unit === false) {
      issues.push({
        section,
        title: code,
        reason: `единица показа «${shown(record.unit)}» — нужно {"name": …, "factor": целое больше нуля}`,
      })
      continue
    }

    const draft = unit ? { code, name, decimals, unit } : { code, name, decimals }
    const currency = { ...createCurrency(known, draft), id: ctx.newId(), updatedAt: ctx.now }
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

/** Единица показа из файла: нет — `null`, кривая — `false`. */
function unitOf(value: unknown): { name: string; factor: number } | null | false {
  if (absent(value)) return null
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const name = textOf(record.name)
  const factor = numberOf(record.factor)
  if (!name || factor === null || !Number.isInteger(factor) || factor <= 0) return false
  return { name, factor }
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
    '"source" — откуда курс, если это публичный источник курсов. Из выписки или от меня — не пиши',
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

    // Источник курса — если его назвали (Р-38: кнопка «Подтянуть курсы»), иначе импорт.
    const source = textOf(record.source) ?? 'import'
    const made: Rate = { id: ctx.newId(), updatedAt: ctx.now, date, from, to, rate, source }
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
    'операции выписки и итоги периодов. Одна строка выписки — одна запись. Перенеси все строки до одной: ' +
    'пропущенная операция — это не «мелочь», а неверный итог месяца. Перевод между двумя моими ' +
    'счетами — одна запись "transfer", а не две. Движения внутри одного счёта (с карты на накопительный ' +
    'того же банка) не пиши вовсе: остатка банка они не меняют. Но их суммы назови в разделе «checks», ' +
    'полями "skippedIn" и "skippedOut": выписка-то приходит на один договор, и его остаток эти движения ' +
    'меняют — без их сумм сверка не сойдётся. Туда же идут суммы операций, у которых дата операции ' +
    'вне периода выписки, а провела их выписка внутри него.\n' +
    'Считай их в обе стороны. Ушедшее с договора и пришедшее на него — одно и то же движение, ' +
    'просто с разных сторон: «перевод на договор 1234» и «перевод с договора 1234», «между счетами ' +
    'одного клиента», «с карты на накопительный». Пришедшее доходом не называй — это не доход, ' +
    'а мои же деньги, переложенные из кармана в карман.\n' +
    'Что считать переводом, а что доходом и расходом:\n' +
    '  - внесение и снятие наличных — это "transfer" со счётом «Наличные» с одной стороны, а не доход и не расход;\n' +
    '  - перевод другому человеку — это "expense" с категорией, а не "transfer". Перевод между своими ' +
    'счетами — только когда обе стороны мои;\n' +
    '  - пополнение, у которого отправитель не назван вовсе, — "income" с категорией «Неразобранные ' +
    'поступления». Не выдумывай ни источник, ни перевод: я разберу это сам, а категория покажет, что ' +
    'именно надо разобрать.\n' +
    'Направление перевода. У "transfer" "account" — это счёт, ОТКУДА деньги ушли, а "toAccount" — ' +
    'куда пришли. Это главная ошибка, которую здесь легко сделать: читая выписку банка, хочется ' +
    'написать этот банк в "account" всегда. Но если по выписке деньги в него ПРИШЛИ, то он идёт ' +
    'в "toAccount", а в "account" — счёт, откуда их прислали. Перепутанное направление бьёт дважды: ' +
    'приход становится расходом, и сверка не сходится на удвоенную сумму.',
  fields: [
    '"kind" — "expense" расход, "income" доход, "transfer" перевод между моими счетами. Обязательно. ' +
      'Знак в выписке говорит направление; кэшбэк и возврат покупки — это "income"',
    '"account" — название счёта из списка ниже. У "expense" и "income" это тот банк, чью выписку ' +
      'читаешь; у "transfer" — счёт, ОТКУДА ушли деньги, и это не всегда он. Обязательно',
    '"amount" — сумма в обычных единицах, положительная, без знака: 1234.56. Обязательно',
    '"date" — дата операции, ГГГГ-ММ-ДД. Обязательна, кроме итога за период',
    '"time" — время, ЧЧ:ММ, если оно есть в выписке. Оно помогает отличить две одинаковые операции',
    '"category" — название категории. Обязательна у "expense" и "income"; у "transfer" её не бывает. ' +
      'Недостающая заведётся. Не понял, что за продавец, — пиши «Прочее», но поле не бросай пустым: ' +
      'запись без категории не загрузится вовсе',
    '"toAccount" — у "transfer" счёт, КУДА пришли деньги, если он мой и понятен из описания. ' +
      'Вместе с "account" (откуда) он и задаёт направление',
    '"special" — true, если трата особая: техника, поездка, лечение. Не уверен — не пиши',
    '"for" — ГГГГ-ММ, если платёж за другой месяц: «интернет за август»',
    '"bankText" — строка выписки как есть. Пиши её всегда: по ней потом видно, что это было',
    '"bankId" — код операции из выписки, если банк его даёт',
    '"note" — что стоит запомнить: например, что операция была в другой валюте',
    '"recurring" — название регулярной из списка ниже, если этот платёж — она: связь, интернет, страховка. Не уверен — не пиши',
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
    {
      // Строка из выписки «Синего банка», но деньги в него ПРИШЛИ:
      // в "account" — откуда, то есть «Зелёный банк», а не тот, чью
      // выписку читаешь.
      kind: 'transfer',
      account: 'Зелёный банк',
      toAccount: 'Синий банк',
      amount: 3000,
      date: '2026-09-16',
      bankText: 'Пополнение из Зелёного банка',
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

    // «Выписка отмечает сама» (Р-06): платёж, узнанный как регулярный, гасит
    // строку блока сам, и вносить его руками второй раз не надо.
    const recurringName = textOf(record.recurring)
    if (recurringName) {
      const template = findByName(data.recurring, recurringName)
      if (template) entry.recurringId = template.id
      else issue(title, `регулярной «${recurringName}» нет — запись загружена без пометки регулярной`)
    }

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

  // Склейки встречных сторон здесь нет и больше не будет (Р-19): одно
  // движение — одна запись, и делает её беседа, которая видит все выписки
  // сразу. Ошибётся — сверка назовёт завышенный приход суммой (Р-16),
  // а не съест запись молча.
  const kept = drafts

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
    lines.push(
      'На каждую выписку, которую я дал, напиши строку в разделе «checks» — иначе её операции не загрузятся.',
    )
  }

  // Счёт истории из списка выше исключён намеренно: выписки на него
  // не ложатся никогда (Р-12, п. 6). Но переносят на него именно беседой —
  // из снимков прежней таблицы, — и промолчать о нём значит не дать
  // беседе места, куда класть итоги периодов.
  const history = data.accounts.filter((each) => !each.deleted && !each.archived && each.ledgerOnly)
  if (history.length > 0) {
    lines.push('', 'Счёт истории — только для итогов прежней таблицы, выписки на него не клади никогда:')
    for (const account of history) lines.push(`  - «${account.name}» (${account.currency})`)
    lines.push(
      'Если мои данные — таблица учёта с итогами за периоды, клади их на этот счёт записями ' +
        'с "periodFrom" и "periodTo" вместо "date", по две записи на период: обычные траты ' +
        'и вторая с "special": true — особые.',
      'Несколько столбцов обычных трат (например «регулярные» и «дефолтные») сложи в одну запись: ' +
        'частота траты категорией не становится и отдельной записью не переносится. Столбец «сумма» ' +
        'не переноси вовсе — это итог строки, приложение сложит сам.',
      'Границы периода бери из столбца с датами, а не из даты обновления строки. Период, у которого ' +
        'начало и конец совпадают, почти всегда опечатка: назови его в списке после JSON.',
    )
  }

  const expense = data.categories.filter((each) => !each.deleted && !each.archived && each.side === 'expense')
  const income = data.categories.filter((each) => !each.deleted && !each.archived && each.side === 'income')
  if (expense.length > 0) lines.push('', `Расходные категории: ${expense.map((each) => each.name).join(', ')}.`)
  if (income.length > 0) lines.push('', `Доходные категории: ${income.map((each) => each.name).join(', ')}.`)

  const recurring = data.recurring.filter((each) => !each.deleted)
  if (recurring.length > 0) {
    lines.push('', `Мои регулярные: ${recurring.map((each) => each.name).join(', ')}.`)
  }

  const samples = promptSamples(data)
  if (samples.length > 0) {
    lines.push('', 'Так я уже раскладывал самые частые описания — держись этого:')
    for (const sample of samples) {
      lines.push(`  - «${sample.text}» → ${sample.category}${sample.special ? ', и это особая трата' : ''}`)
    }
  }

  if (accounts.length > 1) {
    lines.push(
      '',
      'Если выписок несколько, клади их в один файл: тогда перевод между моими счетами, видный ' +
        'в двух выписках, склеится в одну запись. Порознь он приедет дважды, и сверка второго счёта ' +
        'не сойдётся.',
      'Разбирай выписки по одной: доведи первую до конца, потом берись за следующую. На большой ' +
        'выписке легче всего незаметно перейти с переноса на пересказ и бросить половину строк — ' +
        'этого делать нельзя, сверка всё равно не сойдётся и не загрузится ничего.',
    )
  }

  return lines.join('\n')
}

/** Сколько разобранных описаний показывать беседе. Больше — промпт раздувается, толку не прибавляется. */
export const PROMPT_SAMPLES = 20

type Sample = { text: string; category: string; special: boolean }

/**
 * Самые частые описания выписок с тем, в какую категорию они уже разложены
 * (Р-12, п. 8). Справочника правил не заводится: та же раскладка уже лежит
 * в загруженных операциях.
 */
export function promptSamples(data: LedgerImportData, limit: number = PROMPT_SAMPLES): Sample[] {
  const names = new Map(data.categories.filter((each) => !each.deleted).map((each) => [each.id, each.name]))
  const counts = new Map<string, { text: string; category: string; count: number; special: number }>()

  // «Особая» — суждение человека, а не свойство продавца: поездки, техника,
  // лечение у каждого свои. Взять его неоткуда, кроме как из того, что он
  // уже отметил сам, — и тогда беседа перестаёт спрашивать об этом заново.
  //
  // Пометка не входит в ключ, а считается голосованием: одно и то же
  // описание бывает и особым, и обычным, а промпт, сказавший о нём сразу
  // и то и другое, хуже молчания.
  for (const entry of data.entries) {
    if (entry.deleted || !entry.bankText || !entry.categoryId) continue
    const category = names.get(entry.categoryId)
    if (!category) continue
    const key = `${entry.bankText.trim().toLocaleLowerCase('ru')}→${category}`
    const was = counts.get(key) ?? { text: entry.bankText.trim(), category, count: 0, special: 0 }
    was.count += 1
    if (entry.special === true) was.special += 1
    counts.set(key, was)
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ru'))
    .slice(0, limit)
    .map(({ text, category, count, special }) => ({ text, category, special: special * 2 > count }))
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

// ─── Сверка выписки (Р-16) ─────────────────────────────────────────────────

/**
 * Числа, которые выписка говорит о себе сама: остатки на начало и конец
 * периода и обороты. Беседа их переписывает, а не считает.
 *
 * Зачем это есть. Беседа на большой выписке переходит с переноса на
 * пересказ — приносит часть операций и не говорит об этом. Приложение иначе
 * этого не видит: у него нет ничего, с чем сравнить. Сверка даёт то же, что
 * у переноса истории дала сверка сумм по периодам (Р-08), — единственное
 * число, которое не зависит от суждения беседы.
 */
export const checksImportSpec: ImportSpec = {
  section: 'checks',
  about:
    'сверка: числа, которые выписка говорит о себе сама. Не считай их и не складывай — перепиши ' +
    'из выписки как есть. По одной строке на каждую выписку, которую я тебе дал. ' +
    'Без этой строки операции счёта не загрузятся вовсе: иначе мне нечем проверить, что перенесено всё, ' +
    'а не часть.',
  fields: [
    '"account" — название счёта, из того же списка, что и в разделе «entries». Обязательно',
    '"from" и "to" — начало и конец периода выписки, ГГГГ-ММ-ДД. Обязательно',
    '"opening" и "closing" — остаток на начало и на конец периода, как их называет сама выписка',
    '"income" и "expense" — обороты за период: сколько всего пришло и сколько ушло, если выписка их называет',
    'Хотя бы одна пара обязательна — «opening» с «closing» или «income» с «expense». Есть обе — пиши обе: ' +
      'сверяю по остаткам, обороты беру, только если остатков нет',
    '"skippedIn" и "skippedOut" — сколько всего пришло и ушло по строкам выписки, которые НЕ станут ' +
      'записями с датой внутри «from»—«to». Таких строк две породы, и считать надо обе: ' +
      '(1) движения между моими договорами и картами внутри этого же банка — их я не переношу вовсе, ' +
      'но остаток договора они меняют; (2) операции, которые выписка провела в этом периоде, ' +
      'а дата самой операции раньше «from» или позже «to» — я считаю по дате операции, а выписка ' +
      'по дате обработки. Таких строк не было — не пиши',
  ],
  example: [
    {
      account: 'Синий банк',
      from: '2026-08-20',
      to: '2026-09-20',
      opening: 381.02,
      closing: 96.04,
      income: 600,
      expense: 884.98,
      skippedIn: 0,
      skippedOut: 5000,
    },
  ],
}

/** Разобранная строка сверки. Суммы — в минимальных единицах валюты счёта. */
export type Check = {
  accountId: string
  accountName: string
  currency: string
  from: string
  to: string
  opening: number | null
  closing: number | null
  income: number | null
  expense: number | null
  /** Движения внутри счёта, которые беседа намеренно не переносила (Р-12, п. 1; Р-17). */
  skippedIn: number
  skippedOut: number
}

/**
 * Разбор раздела. Записей не создаёт: сверка ничего не хранит, она решает,
 * пускать ли записи. Кривая строка — не «сверка не сошлась», а «сверки нет»:
 * счёт останется непроверенным, и записи не пройдут по тому же правилу.
 */
export function importChecks(raw: unknown, data: LedgerImportData): { checks: Check[]; issues: Issue[] } {
  const section = checksImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const checks: Check[] = []

  for (const { raw: record, index } of records) {
    const name = textOf(record.account)
    const title = name ?? `сверка ${index + 1}`

    if (!name) {
      issues.push({ section, title, reason: 'нет счёта ("account")' })
      continue
    }
    const account = findByName(data.accounts, name)
    if (!account || account.deleted) {
      issues.push({ section, title, reason: `счёта «${name}» нет — заведите его или добавьте в раздел «accounts»` })
      continue
    }
    const currency = findCurrency(data.currencies, account.currency)
    if (!currency) {
      issues.push({ section, title, reason: `валюты ${account.currency} нет в справочнике` })
      continue
    }

    const from = dayOf(record.from)
    const to = dayOf(record.to)
    if (!from || !to) {
      issues.push({ section, title, reason: 'нет границ периода выписки ("from" и "to"), ГГГГ-ММ-ДД' })
      continue
    }
    if (from > to) {
      issues.push({ section, title, reason: `период кончается раньше, чем начинается: ${formatDate(from)} — ${formatDate(to)}` })
      continue
    }

    const opening = signedAmount(record.opening, currency.decimals)
    const closing = signedAmount(record.closing, currency.decimals)
    const income = signedAmount(record.income, currency.decimals)
    const expense = signedAmount(record.expense, currency.decimals)

    const byBalance = opening !== null && closing !== null
    const byTurnover = income !== null && expense !== null
    if (!byBalance && !byTurnover) {
      issues.push({
        section,
        title,
        reason:
          'нечем сверять: нужна пара «opening» и «closing» либо пара «income» и «expense». ' +
          'Возьмите эти числа из выписки — они в ней есть',
      })
      continue
    }

    checks.push({
      accountId: account.id,
      accountName: account.name,
      currency: account.currency,
      from,
      to,
      opening,
      closing,
      income,
      expense,
      skippedIn: signedAmount(record.skippedIn, currency.decimals) ?? 0,
      skippedOut: signedAmount(record.skippedOut, currency.decimals) ?? 0,
    })
  }

  return { checks, issues }
}

/** Сумма из файла со знаком: остаток бывает и отрицательным. Пусто — null. */
function signedAmount(value: unknown, decimals: number): number | null {
  if (absent(value)) return null
  const text = String(value).trim()
  const negative = text.startsWith('-')
  const parsed = parseAmount(negative ? text.slice(1) : text, decimals)
  if (parsed === null) return null
  return negative ? -parsed.amount : parsed.amount
}

/** Приход и расход по счёту за период — по всем записям, где счёт участвует. */
function turnoverOn(entries: readonly Entry[], check: Check): { income: number; expense: number } {
  let income = 0
  let expense = 0

  for (const entry of entries) {
    if (entry.deleted || !entry.date) continue
    if (entry.date < check.from || entry.date > check.to) continue

    if (entry.accountId === check.accountId) {
      if (entry.kind === 'income') income += entry.money.amount
      else expense += entry.money.amount
    } else if (entry.kind === 'transfer' && entry.toAccountId === check.accountId) {
      income += entry.money.amount
    }
  }

  return { income, expense }
}

/**
 * Правило допуска (Р-16).
 *
 * Расход и доход с датой ложатся только на счёт, сверка которого есть
 * и сошлась. Перевод проходит, если сошлась сверка **хотя бы одной** из его
 * сторон: у наличных выписки нет и не будет, а движение наличных как раз
 * и объясняет остаток банка. По «Месяцу» считаются расход и доход — их
 * правило держит жёстко.
 *
 * Итоги периодов сверка не трогает: у них нет даты, и переносятся они
 * не выпиской (Р-14).
 */
/**
 * Отметки «выписка доведена по» — по сошедшимся сверкам (Р-26).
 *
 * Назад отметка не откатывается: загрузили старую выписку поверх свежей —
 * счёт не должен «разучиться» тому, что уже знает.
 *
 * `pending` — счета, заведённые этим же файлом: отметка должна лечь на них,
 * а не на прежнюю копию из базы, иначе одна из двух записей потеряется.
 */
export function loadedThroughUpdates(
  loaded: readonly { accountId: string; through: string }[],
  data: LedgerImportData,
  pending: readonly Account[] = [],
): Account[] {
  const result = new Map<string, Account>()

  for (const { accountId, through } of loaded) {
    const current =
      result.get(accountId) ??
      pending.find((each) => each.id === accountId) ??
      data.accounts.find((each) => each.id === accountId)
    if (!current || current.ledgerOnly) continue
    if (current.loadedThrough !== undefined && current.loadedThrough >= through) continue
    result.set(accountId, { ...current, loadedThrough: through, updatedAt: nowIso() })
  }

  return [...result.values()]
}

export function applyChecks(
  checks: readonly Check[],
  incoming: readonly Entry[],
  data: LedgerImportData,
): { kept: Entry[]; issues: Issue[]; loaded: { accountId: string; through: string }[] } {
  const section = checksImportSpec.section
  const issues: Issue[] = []
  const passed = new Set<string>()
  const loaded: { accountId: string; through: string }[] = []

  // Считается по всему, что окажется в базе: уже лежащие записи плюс новые.
  // Иначе повторная загрузка той же выписки не сошлась бы ни разу — её
  // записи пропускаются как повторы и в `incoming` не попадают.
  const all = [...data.entries, ...incoming]

  for (const check of checks) {
    const currency = findCurrency(data.currencies, check.currency)
    const money = (amount: number) => formatMoney({ amount: Math.abs(amount), currency: check.currency }, currency)
    const counted = turnoverOn(all, check)
    // Движения внутри счёта в базу не идут (Р-12, п. 1), но остаток выписки
    // меняют: выписка у одного договора, а счёт — банк целиком. Беседа
    // называет их суммой, и здесь они встают на своё место (Р-17).
    const actual = {
      income: counted.income + check.skippedIn,
      expense: counted.expense + check.skippedOut,
    }
    const wrong: string[] = []

    if (check.opening !== null && check.closing !== null) {
      const expected = check.opening + actual.income - actual.expense
      const difference = expected - check.closing
      if (difference !== 0) {
        wrong.push(
          `по записям на конец выходит ${money(expected)}, а выписка называет ${money(check.closing)} — ` +
            `${difference > 0 ? 'лишних' : 'не хватает'} ${money(difference)}`,
        )
      }
    } else if (check.income !== null && check.expense !== null) {
      // Обороты — только когда остатков нет: банки считают их по-разному,
      // например показывают кэшбэк отдельной строкой мимо «поступлений».
      if (actual.income !== check.income) {
        wrong.push(`пришло по записям ${money(actual.income)}, а выписка называет ${money(check.income)}`)
      }
      if (actual.expense !== check.expense) {
        wrong.push(`ушло по записям ${money(actual.expense)}, а выписка называет ${money(check.expense)}`)
      }
    }

    if (wrong.length > 0 && check.skippedIn === 0 && check.skippedOut === 0) {
      wrong.push(
        'беседа не объявила ничего в "skippedIn" и "skippedOut" — а туда идут и движения между ' +
          'своими договорами внутри банка, и операции, чья дата вне периода выписки. ' +
          'Это самая частая причина расхождения',
      )
    }

    if (wrong.length === 0) {
      passed.add(check.accountId)
      // Выписка сошлась — значит она и вправду доведена по свой конец
      // периода (Р-26). Это единственное место, где такой факт известен.
      loaded.push({ accountId: check.accountId, through: check.to })
      continue
    }
    issues.push({
      section,
      title: check.accountName,
      reason:
        `сверка за ${formatDate(check.from)} — ${formatDate(check.to)} не сошлась: ${wrong.join('; ')}. ` +
        'Ни одна операция этого счёта не загружена: скорее всего, беседа перенесла не все строки выписки',
    })
  }

  const kept: Entry[] = []
  const dropped = new Map<string, number>()
  const checked = new Set(checks.map((each) => each.accountId))
  const droppedTransfers: Entry[] = []

  for (const entry of incoming) {
    if (!entry.date || allowed(entry, passed)) {
      kept.push(entry)
      continue
    }
    if (entry.kind === 'transfer') droppedTransfers.push(entry)
    else dropped.set(entry.accountId, (dropped.get(entry.accountId) ?? 0) + 1)
  }

  const nameOf = (id: string | undefined) =>
    id === undefined ? null : (data.accounts.find((each) => each.id === id)?.name ?? id)

  for (const [accountId, count] of dropped) {
    // Счёт с несошедшейся сверкой уже назван выше — второй раз не называем.
    if (checked.has(accountId)) continue
    issues.push({
      section,
      title: nameOf(accountId) ?? accountId,
      reason:
        `сверки по этому счёту нет — ${count} ${plural(count, FORMS.entry)} не загружено. ` +
        'Беседа обязана перенести из выписки начальный и конечный остаток или обороты за период',
    })
  }

  // У перевода две стороны, и причина отказа — обе сразу. Сказать про счёт
  // наличных «сверки нет» значило бы послать человека заводить сверку,
  // которой у наличных не будет никогда.
  if (droppedTransfers.length > 0) {
    const sides = new Set<string>()
    for (const entry of droppedTransfers) {
      for (const name of [nameOf(entry.accountId), nameOf(entry.toAccountId)]) if (name) sides.add(name)
    }
    issues.push({
      section,
      title: 'переводы',
      reason:
        `${droppedTransfers.length} ${plural(droppedTransfers.length, FORMS.entry)} не загружено: ` +
        `сверка не сошлась ни по одной из сторон — ${[...sides].join(', ')}. ` +
        'Переводу довольно одной сошедшейся стороны, так что они приедут вместе со счётом, который сойдётся',
    })
  }

  return { kept, issues, loaded }
}

function allowed(entry: Entry, passed: ReadonlySet<string>): boolean {
  if (entry.kind === 'transfer') {
    return passed.has(entry.accountId) || (entry.toAccountId !== undefined && passed.has(entry.toAccountId))
  }
  return passed.has(entry.accountId)
}

/** Все разделы учёта по порядку разбора: справочники раньше записей. */
export const LEDGER_IMPORT_SPECS: readonly ImportSpec[] = [
  currenciesImportSpec,
  accountsImportSpec,
  categoriesImportSpec,
  ratesImportSpec,
  entriesImportSpec,
  checksImportSpec,
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
