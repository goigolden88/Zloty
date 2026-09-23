/**
 * «Новый снимок» — строкой по всем счетам сразу, как строка таблицы (Р-39).
 *
 * Поля заполнены прошлыми значениями: человек меняет то, что изменилось.
 * **Пустое поле — «снимка нет», а не ноль.** У счёта с частями — поле на
 * каждую часть; отложенный платёж вписывается суммой к возврату, а хранится
 * со знаком минус (Р-35).
 *
 * Сохранить строку на дату, где у счёта уже есть снимок, — значит поправить
 * его: прежние записи этой даты уходят в надгробия, иначе две записи одной
 * даты сложились бы и удвоили счёт.
 */

import type { Account, Balance, Currency } from '../../app/model.ts'
import { findCurrency, parseShown, shownValue } from '../money/money.ts'
import { capitalAccounts, latestOf } from './capital.ts'

/** Имя части отложенного платежа по умолчанию. */
export const DEFERRED_PART = 'кредитка'

/** Имя основной части, когда рядом появился отложенный платёж. */
export const MAIN_PART = 'на счёте'

export type PartDraft = {
  /** Имя части; пусто — весь счёт. */
  part: string
  /** Как вписано в поле, в единице показа валюты. */
  value: string
  /** С чего начиналось поле — чтобы показать, что осталось прежним. */
  was: string
  /** Отложенный платёж: в поле — сумма к возврату, в записи — со знаком минус. */
  deferred: boolean
}

export type RowDraft = { accountId: string; parts: PartDraft[] }

/**
 * Черновик строки на дату: каждый живой счёт капитала, кроме архивных,
 * с частями и суммами последнего снимка не позже этой даты.
 */
export function draftRow(
  accounts: readonly Account[],
  balances: readonly Balance[],
  currencies: readonly Currency[],
  day: string,
): RowDraft[] {
  return capitalAccounts(accounts)
    .filter((account) => !account.archived)
    .sort((a, b) => a.order - b.order)
    .map((account) => {
      const currency = findCurrency(currencies, account.currency)
      const found = latestOf(balances, account.id, day)
      const named = found.filter((each) => each.part !== undefined)
      const used = named.length > 0 ? named : found
      if (used.length === 0 || !currency) {
        return { accountId: account.id, parts: [{ part: '', value: '', was: '', deferred: false }] }
      }
      return {
        accountId: account.id,
        parts: used.map((each) => {
          const value = shownValue(Math.abs(each.amount), currency)
          return { part: each.part ?? '', value, was: value, deferred: each.amount < 0 }
        }),
      }
    })
}

/** Добавить отложенный платёж к счёту: основная сумма становится частью со своим именем. */
export function withDeferred(row: RowDraft): RowDraft {
  const parts = row.parts.map((each) => (each.part === '' && !each.deferred ? { ...each, part: MAIN_PART } : each))
  return { ...row, parts: [...parts, { part: DEFERRED_PART, value: '', was: '', deferred: true }] }
}

/** Все поля строки остались как были. Пустая строка прежней не считается — её просто нет. */
export function unchanged(row: RowDraft): boolean {
  return row.parts.some((each) => each.value.trim() !== '') && row.parts.every((each) => each.value.trim() === each.was.trim())
}

export type RowWrites = {
  /** Новые снимки. */
  put: Balance[]
  /** Прежние снимки той же даты у тех же счетов — в надгробия. */
  removed: Balance[]
  /** По какому счёту что не так; есть хоть одна — не пишется ничего. */
  problems: { accountId: string; reason: string }[]
}

/** Что записать по строке: снимки заполненных счетов на одну дату. */
export function rowWrites(
  rows: readonly RowDraft[],
  data: { accounts: readonly Account[]; balances: readonly Balance[]; currencies: readonly Currency[] },
  day: string,
  ctx: { newId: () => string; now: string },
): RowWrites {
  const put: Balance[] = []
  const removed: Balance[] = []
  const problems: RowWrites['problems'] = []

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { put, removed, problems: [{ accountId: '', reason: `дата «${day}» — не ГГГГ-ММ-ДД` }] }
  }

  for (const row of rows) {
    const account = data.accounts.find((each) => each.id === row.accountId && !each.deleted)
    if (!account) continue
    const filled = row.parts.filter((each) => each.value.trim() !== '')
    if (filled.length === 0) continue

    const problem = (reason: string) => problems.push({ accountId: account.id, reason })
    const currency = findCurrency(data.currencies, account.currency)
    if (!currency) {
      problem(`валюты ${account.currency} нет в справочнике`)
      continue
    }

    const names = filled.map((each) => each.part.trim())
    if (filled.length > 1 && names.some((name) => name === '')) {
      problem('у счёта несколько сумм — назовите каждую часть')
      continue
    }
    if (new Set(names).size < names.length) {
      problem('две части с одним именем')
      continue
    }
    if (filled.some((each) => each.deferred && each.part.trim() === '')) {
      problem('назовите отложенный платёж — например, «кредитка»')
      continue
    }

    const made: Balance[] = []
    for (const each of filled) {
      const parsed = parseShown(each.value, currency)
      if (!parsed) {
        problem(`«${each.value}» — не сумма`)
        break
      }
      const part = each.part.trim()
      const record: Balance = {
        id: ctx.newId(),
        updatedAt: ctx.now,
        accountId: account.id,
        date: day,
        // Ноль к возврату — просто ноль, без «минус нуля» в записи.
        amount: each.deferred && parsed.amount > 0 ? -parsed.amount : parsed.amount,
      }
      if (part) record.part = part
      made.push(record)
    }
    if (made.length < filled.length) continue

    put.push(...made)
    removed.push(
      ...data.balances
        .filter((each) => !each.deleted && each.accountId === account.id && each.date === day)
        .map((each) => ({ ...each, deleted: true, updatedAt: ctx.now })),
    )
  }

  return problems.length > 0 ? { put: [], removed: [], problems } : { put, removed, problems }
}
