/**
 * Разовые долги — без комнаты, события и компании (Р-01).
 *
 * «Дал Пете 5 000», «взял у Маши 1 000». Возврат частями законен, и остаток
 * не хранится: он считается по возвратам, как и всё остальное в долгах
 * (условие 4 Р-01).
 *
 * Валюта у разового долга своя — комнаты, которая задавала бы её, здесь нет.
 * Поэтому суммы ходят `Money`, а не голым числом, и складывать долги в разных
 * валютах нельзя: итог человеку собирается по валютам (`summary.ts`).
 */

import type { Loan, Money, Repayment } from '../../app/model.ts'

/** Долг вместе с тем, сколько по нему осталось. */
export type LoanState = {
  loan: Loan
  /** Сколько уже вернули — в валюте долга. */
  repaid: number
  /** Сколько осталось; ноль — долг закрыт. */
  left: number
  closed: boolean
}

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

/** Возвраты по долгу; удалённые и чужой валюты не в счёт. */
export function repaymentsOf(repayments: readonly Repayment[], loan: Loan): Repayment[] {
  return live(repayments).filter(
    (each) => each.loanId === loan.id && each.money.currency === loan.money.currency,
  )
}

/**
 * Возврат в чужой валюте — не ошибка ввода, а то, чего эта модель не умеет:
 * пересчёт по курсу превратил бы «сколько осталось» в оценку. Такие возвраты
 * не молчат — их называет экран.
 */
export function foreignRepayments(repayments: readonly Repayment[], loan: Loan): Repayment[] {
  return live(repayments).filter(
    (each) => each.loanId === loan.id && each.money.currency !== loan.money.currency,
  )
}

/** Состояние долга: сколько вернули и сколько осталось. */
export function loanState(loan: Loan, repayments: readonly Repayment[]): LoanState {
  const repaid = repaymentsOf(repayments, loan).reduce((sum, each) => sum + each.money.amount, 0)
  const left = Math.max(0, loan.money.amount - repaid)
  return { loan, repaid, left, closed: left === 0 }
}

/**
 * Остаток долга со знаком: плюс — человек должен мне, минус — я ему.
 *
 * Знак берётся из `direction`: «дал» — мне должны, «взял» — должен я.
 */
export function signedLeft(loan: Loan, repayments: readonly Repayment[]): Money {
  const { left } = loanState(loan, repayments)
  return {
    amount: loan.direction === 'lent' ? left : -left,
    currency: loan.money.currency,
  }
}

/** Что не так с долгом. `null` — всё сходится. */
export function loanProblem(loan: Loan): string | null {
  if (!Number.isInteger(loan.money.amount) || loan.money.amount <= 0) {
    return 'Сумма долга должна быть целой и больше нуля'
  }
  if (!loan.personId) return 'Не сказано, с кем долг'
  return null
}

/** Что не так с возвратом. `null` — всё сходится. */
export function repaymentProblem(repayment: Repayment, loan: Loan, others: readonly Repayment[]): string | null {
  if (!Number.isInteger(repayment.money.amount) || repayment.money.amount <= 0) {
    return 'Сумма возврата должна быть целой и больше нуля'
  }
  if (repayment.money.currency !== loan.money.currency) {
    return `Долг в ${loan.money.currency}, а возврат в ${repayment.money.currency}`
  }

  const before = repaymentsOf(others, loan)
    .filter((each) => each.id !== repayment.id)
    .reduce((sum, each) => sum + each.money.amount, 0)
  const over = before + repayment.money.amount - loan.money.amount
  if (over > 0) return `Возвращают больше, чем брали, на ${over}`

  return null
}
