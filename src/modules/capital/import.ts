/**
 * Разделы импорта капитала: снимки и заметки (Р-08, Р-09, Р-34…Р-36).
 *
 * Та же дверь, что у выписки: без `id` и `updatedAt`, ссылки по названиям,
 * суммы в обычных единицах, кривое называется с причиной, совпавшее по
 * естественному ключу пропускается. Импорт только добавляет.
 *
 * Счета и валюты заводит раздел учёта `accounts`/`currencies` того же файла —
 * разделы разбираются по порядку, и снимок видит счёт, заведённый выше.
 */

import { plural } from '../../shared/core/dates.ts'
import {
  absent,
  dayOf,
  recordsOf,
  sameText,
  shown,
  textOf,
  type ImportContext,
  type ImportPlan,
  type ImportSpec,
} from '../../shared/core/importing.ts'
import type { Account, Balance, Currency, Note, StoreRecord } from '../../app/model.ts'
import { findCurrency, parseAmount } from '../money/money.ts'

type Plan = ImportPlan<StoreRecord>

/** Что разделам капитала нужно из базы. С надгробиями: по ним видно, какие id заняты. */
export type CapitalImportData = {
  currencies: readonly Currency[]
  accounts: readonly Account[]
  balances: readonly Balance[]
  notes: readonly Note[]
}

export const BALANCE_FORMS: [string, string, string] = ['снимок', 'снимка', 'снимков']
export const NOTE_FORMS: [string, string, string] = ['заметка', 'заметки', 'заметок']

// ─── Снимки ────────────────────────────────────────────────────────────────

export const balancesImportSpec: ImportSpec = {
  section: 'balances',
  about:
    'снимки — сколько лежало на счёте на дату. Одна запись — один счёт на одну дату. Счёт с частями ' +
    '(«на счёте» и «кредитка») — по записи на часть с одной датой; тогда записи без части на эту дату ' +
    'у счёта быть не должно. Остаток из операций не считай: пиши только то, что названо в данных.',
  fields: [
    '"account" — название счёта из списка выше или из раздела «accounts» этого же файла. Обязательно',
    '"date" — дата снимка, ГГГГ-ММ-ДД. Обязательно',
    '"amount" — сколько лежит, в обычных единицах валюты счёта: у биткойна — в BTC, не в mBTC. ' +
      'Без знака. Обязательно',
    '"part" — часть счёта: «на счёте», «кредитка». Нет частей — не пиши',
    '"deferred" — true, если это отложенный платёж: деньги с кредитки, которые лежат на другом счёте. ' +
      'Тогда "amount" — сколько вернуть, без минуса, и "part" обязательна',
    '"note" — заметка к этому снимку. Нет — не пиши',
  ],
  example: [
    { account: 'Наличные', date: '2026-09-01', amount: 15000 },
    { account: 'Банк', date: '2026-09-01', part: 'на счёте', amount: 42000 },
    { account: 'Банк', date: '2026-09-01', part: 'кредитка', amount: 20000, deferred: true },
  ],
}

export function importBalances(raw: unknown, data: CapitalImportData, ctx: ImportContext): Plan {
  const section = balancesImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const known: Balance[] = data.balances.filter((each) => !each.deleted)
  const created: Balance[] = []
  let skipped = 0
  let rounded = 0

  for (const { raw: record, index } of records) {
    const name = textOf(record.account)
    const title = name ? `снимок «${name}»` : `снимок ${index + 1}`
    const refuse = (reason: string) => issues.push({ section, title, reason })

    if (!name) {
      refuse('нет счёта ("account")')
      continue
    }
    const account = data.accounts.find((each) => !each.deleted && sameText(each.name, name))
    if (!account) {
      refuse(`счёта «${name}» нет — заведите его в разделе «accounts» с валютой`)
      continue
    }
    if (account.ledgerOnly) {
      refuse('это счёт истории прежней таблицы — денег на нём нет, снимков у него не бывает')
      continue
    }
    const currency = findCurrency(data.currencies.filter((each) => !each.deleted), account.currency)
    if (!currency) {
      refuse(`валюты ${account.currency} нет в справочнике`)
      continue
    }

    const date = dayOf(record.date)
    if (!date) {
      refuse(absent(record.date) ? 'нет даты ("date")' : `дата «${shown(record.date)}» — не ГГГГ-ММ-ДД`)
      continue
    }

    const parsed = typeof record.amount === 'number' || typeof record.amount === 'string'
      ? parseAmount(record.amount, currency.decimals)
      : null
    if (!parsed) {
      if (absent(record.amount)) {
        refuse('нет суммы ("amount")')
        continue
      }
      refuse(`сумма «${shown(record.amount)}» — не число без знака`)
      continue
    }
    if (parsed.rounded) rounded += 1

    const part = textOf(record.part) ?? undefined
    const deferred = record.deferred === true
    if (deferred && !part) {
      refuse('отложенный платёж пишется только частью счёта — нужна "part", например «кредитка»')
      continue
    }

    const sameDay = known.filter((each) => each.accountId === account.id && each.date === date)
    if (sameDay.some((each) => (each.part === undefined) !== (part === undefined))) {
      refuse(`на ${date} у счёта уже есть снимок ${part ? 'без частей' : 'по частям'} — вместе они не складываются`)
      continue
    }
    // Естественный ключ снимка — счёт, дата и часть: пришедший второй раз не удваивается.
    if (sameDay.some((each) => each.part === part)) {
      skipped += 1
      continue
    }

    const made: Balance = {
      id: ctx.newId(),
      updatedAt: ctx.now,
      accountId: account.id,
      date,
      amount: deferred && parsed.amount > 0 ? -parsed.amount : parsed.amount,
    }
    if (part) made.part = part
    const note = textOf(record.note)
    if (note) made.note = note
    known.push(made)
    created.push(made)
  }

  // Снимки загрузятся — это не отказ, а то, на что стоит посмотреть (Я-07 ядра).
  const notes =
    rounded > 0
      ? [
          {
            section,
            title: 'округление',
            text: `у ${rounded} ${plural(rounded, BALANCE_FORMS)} было больше знаков после запятой, чем у валюты счёта — сумма округлена`,
          },
        ]
      : []

  return {
    writes: { balances: created },
    added: [{ count: created.length, forms: BALANCE_FORMS }].filter((each) => each.count > 0),
    skipped,
    issues,
    notes,
  }
}

// ─── Заметки к капиталу ────────────────────────────────────────────────────

export const notesImportSpec: ImportSpec = {
  section: 'notes',
  about:
    'заметки к капиталу на дату — комментарии про всё сразу, а не про один счёт: «просадка из-за ' +
    'коррекции крипты». Заметка про один счёт — поле "note" у его снимка.',
  fields: [
    '"date" — к какой дате, ГГГГ-ММ-ДД. Обязательно',
    '"text" — текст, как написан. Обязательно',
  ],
  example: [{ date: '2026-09-01', text: 'рынок просел, доллар вырос' }],
}

export function importNotes(raw: unknown, data: CapitalImportData, ctx: ImportContext): Plan {
  const section = notesImportSpec.section
  const { records, issues } = recordsOf(section, raw)
  const known: Note[] = data.notes.filter((each) => !each.deleted)
  const created: Note[] = []
  let skipped = 0

  for (const { raw: record, index } of records) {
    const title = `заметка ${index + 1}`
    const date = dayOf(record.date)
    if (!date) {
      issues.push({ section, title, reason: absent(record.date) ? 'нет даты ("date")' : `дата «${shown(record.date)}» — не ГГГГ-ММ-ДД` })
      continue
    }
    const text = textOf(record.text)
    if (!text) {
      issues.push({ section, title, reason: 'нет текста ("text")' })
      continue
    }
    if (known.some((each) => each.about === 'capital' && each.date === date && sameText(each.text, text))) {
      skipped += 1
      continue
    }
    const made: Note = { id: ctx.newId(), updatedAt: ctx.now, about: 'capital', date, text }
    known.push(made)
    created.push(made)
  }

  return {
    writes: { notes: created },
    added: [{ count: created.length, forms: NOTE_FORMS }].filter((each) => each.count > 0),
    skipped,
    issues,
  }
}

/** Разделы капитала для промпта — с живым списком счетов, на которые ложатся снимки. */
export function capitalSpecs(data: Pick<CapitalImportData, 'accounts'>): ImportSpec[] {
  const accounts = data.accounts.filter((each) => !each.deleted && !each.archived && !each.ledgerOnly)
  if (accounts.length === 0) return [balancesImportSpec, notesImportSpec]
  const list = [
    'Счета, на которые ложатся снимки:',
    ...accounts.map((each) => `  - «${each.name}» (${each.currency}, ${each.kind === 'investment' ? 'вложения' : 'сбережения'})`),
  ].join('\n')
  return [{ ...balancesImportSpec, about: [balancesImportSpec.about, '', list].join('\n') }, notesImportSpec]
}
