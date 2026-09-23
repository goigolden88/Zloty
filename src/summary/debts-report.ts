/**
 * Долги в отчёте месяца (Р-29, Р-31).
 *
 * Отчёт собирает `modules/ledger/report.ts`, и про комнаты он не знает —
 * и знать не должен. Числа для него готовятся здесь: это вторая сводка,
 * которой можно смотреть на оба модуля сразу.
 *
 * Две величины, названные Р-31:
 * — сколько в этом месяце **не вошло** в расход как чужая доля и по скольким
 *   операциям. Без этого беседа увидит расход меньше банковского и объяснит
 *   разницу чем угодно;
 * — сколько человеку должны и сколько должен он **на конец месяца**. Долг
 *   не расход и не доход, но он и есть та причина, по которой расход месяца
 *   меньше, чем ушло со счёта.
 */

import type { Entry, Money } from '../app/model.ts'
import { debtTotals, type DebtsData } from '../modules/debts/summary.ts'
import { convertTo, type Missing, type MonthData } from '../modules/ledger/month.ts'
import { lastDayOf } from '../shared/core/dates.ts'
import { ownShares } from './shares.ts'

export type ReportDebts = {
  /** Чужая доля, не вошедшая в расход месяца: сумма в базовой и по скольким операциям. */
  cut: { amount: number; entries: number }
  /** На конец месяца, в базовой валюте. */
  owedToMe: number
  owedByMe: number
  /** Операции, чья связь ведёт в никуда, и те, у которых связи в разных валютах. */
  broken: number
  mixed: number
  /** Пометки «это я» нет — доли не считались вовсе. */
  noSelf: boolean
  /** Чего не хватило курса: позиция без курса не пропадает молча (Р-04). */
  missing: Missing[]
}

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

/** Записи долгов по состоянию на день включительно: позже — ещё не случилось. */
function upTo(debts: DebtsData, day: string): DebtsData {
  return {
    people: debts.people,
    rooms: debts.rooms,
    roomEvents: debts.roomEvents,
    roomSpends: live(debts.roomSpends).filter((each) => each.date <= day),
    roomTransfers: live(debts.roomTransfers).filter((each) => each.date <= day),
    loans: live(debts.loans).filter((each) => each.date <= day),
    repayments: live(debts.repayments).filter((each) => each.date <= day),
  }
}

/** Числа долгов для отчёта месяца. Долгов нет — всё по нулям. */
export function debtsForReport(input: {
  /** ГГГГ-ММ */
  month: string
  /** Операции этого месяца — те же, по которым считан расход. */
  entries: readonly Entry[]
  debts: DebtsData
  data: MonthData
}): ReportDebts {
  const { month, entries, debts, data } = input
  const end = lastDayOf(month)
  const missing = new Map<string, Missing>()

  const note = (each: Missing) => {
    const key = `${each.currency}:${each.date}`
    const was = missing.get(key)
    if (was) was.count += 1
    else missing.set(key, { ...each })
  }

  const toBase = (money: Money, day: string): number => {
    const result = convertTo(money, day, data)
    if ('missing' in result) {
      note(result.missing)
      return 0
    }
    return result.amount
  }

  // Сколько не вошло в расход: разница между суммой банка и долей.
  const shares = ownShares(entries, debts)
  let amount = 0
  let counted = 0
  for (const entry of live(entries)) {
    const share = shares.amounts.get(entry.id)
    if (!share) continue
    const day = entry.date ?? entry.period?.to ?? end
    const cut = toBase(entry.money, day) - toBase(share, day)
    if (cut === 0) continue
    amount += cut
    counted += 1
  }

  const totals = debtTotals(upTo(debts, end))
  const sum = (list: readonly Money[]) => list.reduce((all, money) => all + toBase(money, end), 0)

  return {
    cut: { amount, entries: counted },
    owedToMe: sum(totals.owedToMe),
    owedByMe: sum(totals.owedByMe),
    broken: shares.broken.length,
    mixed: shares.mixed.length,
    noSelf: shares.noSelf,
    missing: [...missing.values()],
  }
}
