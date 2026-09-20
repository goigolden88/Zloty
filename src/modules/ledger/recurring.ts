/**
 * Регулярные — шаблоны, которые сами ничего не пишут (Р-06).
 *
 * Главный довод решения: месяц не копируется. Лист Excel человек копировал
 * с прошлого месяца целиком, и вместе с суммами переезжали прошлогодние
 * ошибки. Шаблон помнит, **чего ждать**, а запись появляется только тапом
 * «Внести» — или сама, когда платёж придёт выпиской.
 *
 * Что здесь важно:
 *
 * — **Шаблон не знает, расход он или доход:** это говорит сторона его
 *   категории (Р-05). Стипендия — такая же регулярная, как связь;
 * — **«внесена за месяц» ищется по `recurringId` и `for`,** а не по дате:
 *   интернет за август, оплаченный в сентябре, — августовский платёж,
 *   и блок августа обязан погаснуть (Р-06);
 * — **раз в N месяцев считается от `from`,** а не от начала года: годовая
 *   страховка, заведённая в марте, ждёт марта, а не января.
 */

import { nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'
import type { Account, Category, Entry, Money, Recurring } from '../../app/model.ts'
import { cleanName, nameProblem, nextOrder } from './ledger.ts'

/** Что нужно, чтобы решить, действует ли шаблон и внесён ли он. */
export type RecurringData = {
  recurring: readonly Recurring[]
  categories: readonly Category[]
  accounts: readonly Account[]
  entries: readonly Entry[]
}

// ─── Месяцы ────────────────────────────────────────────────────────────────

/** Сколько месяцев от `from` до `month`. Отрицательное — `month` раньше. */
export function monthsBetween(from: string, month: string): number {
  const years = Number(month.slice(0, 4)) - Number(from.slice(0, 4))
  return years * 12 + (Number(month.slice(5, 7)) - Number(from.slice(5, 7)))
}

/**
 * Ждём ли этот шаблон в этом месяце.
 *
 * Раз в N месяцев отсчитывается от `from`: страховка, заведённая в марте,
 * ждёт марта следующего года, а не января.
 */
export function dueIn(recurring: Recurring, month: string): boolean {
  if (recurring.deleted) return false
  if (month < recurring.from) return false
  if (recurring.to && month > recurring.to) return false

  const step = recurring.every.months
  if (!Number.isInteger(step) || step < 1) return false
  return monthsBetween(recurring.from, month) % step === 0
}

// ─── Внесено или нет ───────────────────────────────────────────────────────

/**
 * Записи, отмеченные этим шаблоном за этот месяц.
 *
 * Считается и `for` — «за какой месяц», — и дата: выписка ставит `for`,
 * а внесённое тапом ложится в сам месяц. Оба случая — один платёж.
 */
export function entriesFor(entries: readonly Entry[], recurringId: string, month: string): Entry[] {
  return entries.filter((each) => {
    if (each.deleted || each.recurringId !== recurringId) return false
    if (each.for) return each.for === month
    return each.date?.startsWith(`${month}-`) === true
  })
}

/** Строка блока «Регулярные»: шаблон, ждём ли его и чем он уже закрыт. */
export type Due = {
  recurring: Recurring
  /** Записи, которыми он уже закрыт в этом месяце. Пусто — ещё нет. */
  entries: Entry[]
  /** Сколько уже внесено — в валюте шаблона. */
  paid: number
}

/**
 * Что ждёт этого месяца. Внесённое не исчезает из списка: человек должен
 * видеть, что платёж был, а не только то, чего не хватает (Р-06).
 */
export function dueThisMonth(data: RecurringData, month: string): Due[] {
  return data.recurring
    .filter((each) => dueIn(each, month))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'))
    .map((recurring) => {
      const entries = entriesFor(data.entries, recurring.id, month)
      const paid = entries
        .filter((each) => each.money.currency === recurring.expected.currency)
        .reduce((all, each) => all + each.money.amount, 0)
      return { recurring, entries, paid }
    })
}

/** Сколько из ожидаемого ещё не внесено. Отрицательное — заплачено больше. */
export function leftToPay(due: Due): number {
  return due.recurring.expected.amount - due.paid
}

// ─── Внести ────────────────────────────────────────────────────────────────

/**
 * День, которым ложится запись, внесённая тапом.
 *
 * Текущий месяц — сегодня: платёж случился сегодня. Прошлый или будущий —
 * последний день того месяца: иначе запись уехала бы в сегодняшний месяц,
 * блок того месяца так и остался бы незакрытым, а расход посчитался бы
 * не там.
 */
export function dayFor(month: string, today: string): string {
  if (today.startsWith(`${month}-`)) return today
  const year = Number(month.slice(0, 4))
  const number = Number(month.slice(5, 7))
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return `${month}-${String(last).padStart(2, '0')}`
}

export type Entered = { entry: Entry } | { problem: string }

/**
 * Запись по шаблону. Вид берётся у стороны категории: шаблон сам не знает,
 * расход он или доход.
 *
 * Сумма — ожидаемая; поправить её человек может на самой записи. Спрашивать
 * сумму каждый раз значило бы, что шаблон не помнит ничего полезного.
 */
export function enterRecurring(
  recurring: Recurring,
  data: RecurringData,
  month: string,
  today: string,
  id: string = ulid(),
): Entered {
  const category = data.categories.find((each) => each.id === recurring.categoryId && !each.deleted)
  if (!category) return { problem: `у регулярной «${recurring.name}» нет категории — она удалена` }

  const account = recurring.accountId
    ? data.accounts.find((each) => each.id === recurring.accountId && !each.deleted)
    : null
  if (recurring.accountId && !account) return { problem: `у регулярной «${recurring.name}» нет счёта — он удалён` }
  if (!account) return { problem: `у регулярной «${recurring.name}» не выбран счёт — укажите его в шаблоне` }

  if (recurring.expected.currency !== account.currency) {
    return {
      problem:
        `регулярная «${recurring.name}» ждёт ${recurring.expected.currency}, ` +
        `а счёт «${account.name}» ведётся в ${account.currency}`,
    }
  }

  const entry: Entry = {
    id,
    updatedAt: nowIso(),
    kind: category.side === 'income' ? 'income' : 'expense',
    accountId: account.id,
    money: { ...recurring.expected },
    date: dayFor(month, today),
    categoryId: category.id,
    recurringId: recurring.id,
    for: month,
  }

  return { entry }
}

/** Всё, чего ещё не хватает в этом месяце, — одним действием. */
export function enterAll(data: RecurringData, month: string, today: string): { entries: Entry[]; problems: string[] } {
  const entries: Entry[] = []
  const problems: string[] = []

  for (const due of dueThisMonth(data, month)) {
    if (due.entries.length > 0) continue
    const made = enterRecurring(due.recurring, data, month, today)
    if ('problem' in made) problems.push(made.problem)
    else entries.push(made.entry)
  }

  return { entries, problems }
}

// ─── Заведение шаблона ─────────────────────────────────────────────────────

export type RecurringDraft = {
  name: string
  categoryId: string
  accountId?: string
  expected: Money
  everyMonths: number
  from: string
  to?: string
}

const MONTH = /^\d{4}-\d{2}$/

export function recurringProblem(
  data: RecurringData,
  draft: RecurringDraft,
  selfId?: string,
): string | null {
  const problem = nameProblem(data.recurring, draft.name, selfId)
  if (problem === 'empty') return 'у регулярной нет названия'
  if (problem) return `регулярная «${cleanName(draft.name)}» уже есть`

  if (!data.categories.some((each) => each.id === draft.categoryId && !each.deleted)) {
    return 'не выбрана категория'
  }
  if (draft.accountId && !data.accounts.some((each) => each.id === draft.accountId && !each.deleted)) {
    return 'счёта нет в справочнике'
  }
  if (!(draft.expected.amount > 0)) return 'ожидаемая сумма — больше нуля'
  if (!Number.isInteger(draft.everyMonths) || draft.everyMonths < 1) {
    return 'повтор — целое число месяцев: 1 — каждый месяц, 12 — раз в год'
  }
  if (!MONTH.test(draft.from)) return 'месяц начала — ГГГГ-ММ'
  if (draft.to && !MONTH.test(draft.to)) return 'месяц конца — ГГГГ-ММ'
  if (draft.to && draft.to < draft.from) return 'регулярная кончается раньше, чем начинается'
  return null
}

export function createRecurring(list: readonly Recurring[], draft: RecurringDraft): Recurring {
  return fill(draft, { id: ulid(), updatedAt: nowIso(), order: nextOrder(list) })
}

export function updateRecurring(record: Recurring, draft: RecurringDraft): Recurring {
  return fill(draft, { id: record.id, updatedAt: nowIso(), order: record.order })
}

function fill(draft: RecurringDraft, base: { id: string; updatedAt: string; order: number }): Recurring {
  const recurring: Recurring = {
    ...base,
    name: cleanName(draft.name),
    categoryId: draft.categoryId,
    expected: { ...draft.expected },
    every: { months: draft.everyMonths },
    from: draft.from,
  }
  if (draft.accountId) recurring.accountId = draft.accountId
  if (draft.to) recurring.to = draft.to
  return recurring
}
