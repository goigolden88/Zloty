/**
 * Записи учёта: операция, перевод между своими счетами и итог периода —
 * заведение и правила (Р-02, Р-12).
 *
 * Чистые функции, без React и без базы. Правил здесь больше, чем кажется,
 * и каждое стоит за решением:
 *
 * — **сумма всегда положительная, направление даёт `kind`** (Р-12, п. 7):
 *   знака в модели нет вовсе, иначе правда о направлении лежала бы в двух
 *   местах и однажды разошлась;
 * — **перевод — одна запись, не доход и не расход** (Р-12, п. 3); движение
 *   внутри одного счёта не записывается вовсе — оно ничего не меняет;
 * — **итог периода держит `period` вместо `date`**, счёт обязателен,
 *   категория — нет (Р-12, п. 6);
 * — **на один счёт в одном периоде — либо итог, либо операции** (Р-02).
 *   Это единственное правило, которое нельзя проверить по одной записи:
 *   ему нужно всё, что уже лежит на этом счёте.
 *
 * Внесённая руками запись **не получает `ext`**: он пишется только импортом
 * и только один раз (Р-12, п. 4). Поэтому руками вносят лишь то, чего в
 * выписке не будет, — наличные; иначе выйдет дубль (Р-12, «Цена», п. 2).
 */

import { formatDate, nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'
import type { Account, Currency, Entry } from '../../app/model.ts'
import { parseAmount } from '../money/money.ts'

/** Что вводит человек. Сумма — строкой, как он её написал: «1 234,56». */
export type EntryDraft = {
  kind: Entry['kind']
  accountId: string
  amount: string
  /** ГГГГ-ММ-ДД — операция. Итог периода даты не имеет. */
  date?: string
  /** ЧЧ:ММ, если известно. */
  time?: string
  /** Итог периода вместо даты. */
  period?: { from: string; to: string }
  categoryId?: string
  toAccountId?: string
  special?: boolean
  /** ГГГГ-ММ — «за какой период» (Р-06). */
  for?: string
  note?: string
}

/** Справочники, без которых запись не проверить. */
export type EntryData = {
  accounts: readonly Account[]
  currencies: readonly Currency[]
  categories: readonly { id: string; side: 'expense' | 'income'; deleted?: boolean }[]
  entries: readonly Entry[]
}

export type Made = { entry: Entry } | { problem: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTH = /^\d{4}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/

/**
 * Собрать запись из введённого — или сказать, что не так.
 *
 * Возвращает одно из двух, а не бросает: причина показывается человеку
 * в форме, а не в журнале ошибок.
 */
export function makeEntry(draft: EntryDraft, data: EntryData, id: string = ulid()): Made {
  const account = data.accounts.find((each) => each.id === draft.accountId && !each.deleted)
  if (!account) return { problem: 'не выбран счёт' }

  const currency = data.currencies.find((each) => each.code === account.currency && !each.deleted)
  if (!currency) return { problem: `валюты ${account.currency} нет в справочнике` }

  const parsed = parseAmount(draft.amount, currency.decimals)
  if (!parsed) return { problem: 'сумма — положительное число: 1234,56. Знак не ставится' }
  if (parsed.amount === 0) return { problem: 'сумма — больше нуля' }

  // Ровно одно из двух: операция с датой или итог периода. Запись без того
  // и другого негде разместить в раскладке, а с тем и другим — непонятно,
  // чем она является.
  const when = whenProblem(draft)
  if (when) return { problem: when }

  if (draft.time && !TIME.test(draft.time)) return { problem: 'время — ЧЧ:ММ' }
  if (draft.for && !MONTH.test(draft.for)) return { problem: '«за какой период» — ГГГГ-ММ' }

  const kindProblem = checkKind(draft, data, account)
  if (kindProblem) return { problem: kindProblem }

  const clash = periodClash(draft, data, account.id)
  if (clash) return { problem: clash }

  const entry: Entry = {
    id,
    updatedAt: nowIso(),
    kind: draft.kind,
    accountId: account.id,
    money: { amount: parsed.amount, currency: account.currency },
  }

  if (draft.date) entry.date = draft.date
  if (draft.period) entry.period = draft.period
  if (draft.time) entry.time = draft.time
  if (draft.categoryId && draft.kind !== 'transfer') entry.categoryId = draft.categoryId
  if (draft.toAccountId && draft.kind === 'transfer') entry.toAccountId = draft.toAccountId
  if (draft.special) entry.special = true
  if (draft.for) entry.for = draft.for
  if (draft.note?.trim()) entry.note = draft.note.trim()

  return { entry }
}

function whenProblem(draft: EntryDraft): string | null {
  const hasDate = Boolean(draft.date)
  const hasPeriod = Boolean(draft.period)
  if (hasDate && hasPeriod) return 'запись бывает или на дату, или за период — не то и другое сразу'
  if (!hasDate && !hasPeriod) return 'не указана дата'

  if (draft.date && !DATE.test(draft.date)) return 'дата — ГГГГ-ММ-ДД'
  if (draft.period) {
    const { from, to } = draft.period
    if (!DATE.test(from) || !DATE.test(to)) return 'границы периода — ГГГГ-ММ-ДД'
    if (from > to) return 'период кончается раньше, чем начинается'
  }
  return null
}

function checkKind(draft: EntryDraft, data: EntryData, account: Account): string | null {
  if (draft.kind === 'transfer') {
    if (draft.categoryId) return 'у перевода между своими счетами категории нет: это не расход и не доход'
    if (draft.toAccountId) {
      if (draft.toAccountId === account.id) {
        return 'движение внутри одного счёта не записывается: остатка счёта оно не меняет'
      }
      const other = data.accounts.find((each) => each.id === draft.toAccountId && !each.deleted)
      if (!other) return 'второго счёта нет в справочнике'
    }
    if (draft.special) return 'особой бывает трата, а не перевод'
    return null
  }

  // У итога периода категория необязательна (Р-12): в таблице её и не было.
  if (!draft.categoryId) return draft.period ? null : 'не выбрана категория'

  const category = data.categories.find((each) => each.id === draft.categoryId && !each.deleted)
  if (!category) return 'категории нет в справочнике'
  if (category.side !== draft.kind) {
    return category.side === 'income'
      ? 'это доходная категория, а запись — расход'
      : 'это расходная категория, а запись — доход'
  }
  return null
}

// ─── «Либо итог, либо операции» (Р-02) ─────────────────────────────────────

/** Пересекаются ли два отрезка дат. Границы включительно. */
function overlap(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  return a.from <= b.to && b.from <= a.to
}

/** Отрезок, который занимает запись: у операции — один день. */
function span(entry: Entry): { from: string; to: string } | null {
  if (entry.period) return entry.period
  if (entry.date) return { from: entry.date, to: entry.date }
  return null
}

/**
 * Итог периода и операции на одном счёте в одном промежутке — двойной счёт
 * (Р-02, «Известные слабые места»). Здесь он и ловится: до записи, с
 * объяснением, а не сводкой расхода вдвое больше настоящего.
 *
 * **Столкновением считаются только записи одной природы** (Р-14): того же
 * вида и с тем же признаком «особая». Разные природы в одном периоде — это
 * не двойной счёт, а разбивка:
 *
 * — итог расхода и доход того же периода говорят о разном, и запретить
 *   второе значило бы, что в период с итогом дохода вообще не внести;
 * — обычный итог и особый итог того же периода — ровно то, как устроен лист
 *   расходов прежней таблицы: три столбца по частоте трат. Без этой разбивки
 *   «обычный месяц» на истории был бы завышен на все особые траты — то
 *   самое число, ради которого история и переносится (Р-07).
 *
 * Переводы не в счёт вовсе: они не расход и не доход.
 */
export function periodClash(draft: EntryDraft, data: EntryData, accountId: string): string | null {
  const mine = draft.period ?? (draft.date ? { from: draft.date, to: draft.date } : null)
  if (!mine) return null
  if (draft.kind === 'transfer') return null

  const onAccount = data.entries.filter(
    (each) =>
      !each.deleted &&
      each.accountId === accountId &&
      each.kind === draft.kind &&
      Boolean(each.special) === Boolean(draft.special),
  )

  if (draft.period) {
    const hit = onAccount.find((each) => {
      const its = each.period ? null : span(each)
      return its !== null && overlap(mine, its)
    })
    if (hit) {
      return (
        `на этом счёте внутри периода уже есть операции (например, за ${formatDate(hit.date ?? '')}). ` +
        'На один счёт в одном периоде — либо итог, либо операции'
      )
    }
    const twin = onAccount.find((each) => each.period && overlap(mine, each.period))
    if (twin) {
      return (
        `на этом счёте уже есть такой же итог за ${formatDate(twin.period?.from ?? '')} — ` +
        `${formatDate(twin.period?.to ?? '')}, и периоды пересекаются`
      )
    }
    return null
  }

  const cover = onAccount.find((each) => each.period && overlap(mine, each.period))
  if (cover) {
    return (
      `этот день на этом счёте уже покрыт итогом за ${formatDate(cover.period?.from ?? '')} — ` +
      `${formatDate(cover.period?.to ?? '')}. Либо итог, либо операции`
    )
  }
  return null
}

// ─── Чтение ────────────────────────────────────────────────────────────────

/** Записи месяца: операции — по дате, итоги — те, что месяц задевают. */
export type MonthEntries = {
  /** Операции и переводы с датой внутри месяца. */
  operations: Entry[]
  /** Итоги периодов, пересекающихся с месяцем. По месяцам они не дробятся (Р-12). */
  periods: Entry[]
}

export function entriesOfMonth(entries: readonly Entry[], month: string): MonthEntries {
  // Границы сравниваются как строки, поэтому 31-е годится и февралю:
  // несуществующей даты в данных нет, а всякая настоящая дата февраля
  // меньше «ГГГГ-02-31».
  const bounds = { from: `${month}-01`, to: `${month}-31` }

  const live = entries.filter((each) => !each.deleted)
  const operations = live
    .filter((each) => each.date?.startsWith(`${month}-`))
    .sort(byTime)
  const periods = live.filter((each) => each.period && overlap(bounds, each.period))

  return { operations, periods }
}

/**
 * Позже — выше. Время есть не у всех записей (Р-12): банк его даёт не
 * всегда, и без времени запись встаёт в начало своего дня, а не теряется.
 * При равенстве порядок даёт id: ULID сортируется по времени создания.
 */
function byTime(a: Entry, b: Entry): number {
  const date = (b.date ?? '').localeCompare(a.date ?? '')
  if (date !== 0) return date
  const time = (b.time ?? '').localeCompare(a.time ?? '')
  if (time !== 0) return time
  return b.id.localeCompare(a.id)
}

/** Последний день, за который на счёте есть операции. Нужен промпту импорта (Р-12, п. 5). */
export function lastDayOn(entries: readonly Entry[], accountId: string): string | null {
  let last: string | null = null
  for (const entry of entries) {
    if (entry.deleted || entry.accountId !== accountId) continue
    const day = entry.date ?? entry.period?.to ?? null
    if (day && (last === null || day > last)) last = day
  }
  return last
}
