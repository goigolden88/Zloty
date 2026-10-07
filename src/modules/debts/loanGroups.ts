/**
 * Открытые разовые долги — группами по человеку (Р-58).
 *
 * Вопрос «что у меня с Петей» — про человека, а не про отдельный долг. Итог
 * группы считается тем же правилом, что строка человека в «Кто кому должен»
 * (`debtsByPerson`): по валютам, со знаком, нули убраны. Валюты не
 * складываются (Р-04).
 *
 * Порядок групп — как при выборе людей (Р-56, `sortedPeople`): «я», важные,
 * остальные, каждые по алфавиту. Человек в архиве или удалённый из
 * справочника, а долг с ним открыт, — группа не пропадает, а уходит в конец.
 */

import type { Loan, Money, Person, Repayment } from '../../app/model.ts'
import { loanState, signedLeft } from './loans.ts'
import { orderedIds } from './records.ts'

export type LoanGroup = {
  personId: string
  /** Итог разовых долгов с человеком: плюс — он должен мне, минус — я ему. */
  amounts: Money[]
  /** Открытые долги с ним — по дате, старые выше. */
  loans: Loan[]
}

/** Открытые разовые долги по людям; закрытые и удалённые в группы не идут. */
export function loanGroups(
  people: readonly Person[],
  loans: readonly Loan[],
  repayments: readonly Repayment[],
): LoanGroup[] {
  const open = loans
    .filter((loan) => !loan.deleted && !loanState(loan, repayments).closed)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  const found = new Map<string, LoanGroup>()
  for (const loan of open) {
    const group = found.get(loan.personId) ?? { personId: loan.personId, amounts: [], loans: [] }
    const money = signedLeft(loan, repayments)
    const same = group.amounts.find((each) => each.currency === money.currency)
    if (same) same.amount += money.amount
    else group.amounts.push({ ...money })
    group.loans.push(loan)
    found.set(loan.personId, group)
  }

  return orderedIds(people, [...found.keys()]).flatMap((id) => {
    const group = found.get(id)
    return group ? [{ ...group, amounts: group.amounts.filter((money) => money.amount !== 0) }] : []
  })
}
