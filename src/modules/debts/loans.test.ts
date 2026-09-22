import { describe, expect, it } from 'vitest'
import type { Loan, Repayment } from '../../app/model.ts'
import {
  foreignRepayments,
  loanProblem,
  loanState,
  repaymentProblem,
  repaymentsOf,
  signedLeft,
} from './loans.ts'

/** Люди выдуманные: код публичный (CLAUDE.md). */
const BORYA = 'person-borya'

function loan(over: Partial<Loan> & { id: string }): Loan {
  return {
    updatedAt: '2026-09-22T10:00:00.000Z',
    personId: BORYA,
    direction: 'lent',
    money: { amount: 500000, currency: 'RUB' },
    date: '2026-08-10',
    ...over,
  }
}

function repayment(over: Partial<Repayment> & { id: string }): Repayment {
  return {
    updatedAt: '2026-09-22T10:00:00.000Z',
    loanId: 'loan-1',
    money: { amount: 200000, currency: 'RUB' },
    date: '2026-09-01',
    ...over,
  }
}

describe('остаток долга считается по возвратам, а не хранится', () => {
  it('без возвратов должен всю сумму', () => {
    expect(loanState(loan({ id: 'loan-1' }), [])).toMatchObject({ repaid: 0, left: 500000, closed: false })
  })

  it('возврат частями законен — остаток уменьшается', () => {
    const state = loanState(loan({ id: 'loan-1' }), [
      repayment({ id: 'r1' }),
      repayment({ id: 'r2', money: { amount: 100000, currency: 'RUB' } }),
    ])
    expect(state.repaid).toBe(300000)
    expect(state.left).toBe(200000)
    expect(state.closed).toBe(false)
  })

  it('вернули всё — долг закрыт', () => {
    const state = loanState(loan({ id: 'loan-1' }), [
      repayment({ id: 'r1', money: { amount: 500000, currency: 'RUB' } }),
    ])
    expect(state.left).toBe(0)
    expect(state.closed).toBe(true)
  })

  it('вернули больше, чем брали, — остаток не уходит в минус', () => {
    const state = loanState(loan({ id: 'loan-1' }), [
      repayment({ id: 'r1', money: { amount: 700000, currency: 'RUB' } }),
    ])
    expect(state.left).toBe(0)
  })

  it('удалённый возврат не считается', () => {
    const state = loanState(loan({ id: 'loan-1' }), [repayment({ id: 'r1', deleted: true })])
    expect(state.left).toBe(500000)
  })

  it('возврат чужого долга сюда не попадает', () => {
    expect(repaymentsOf([repayment({ id: 'r1', loanId: 'loan-other' })], loan({ id: 'loan-1' }))).toEqual([])
  })
})

describe('знак долга: «дал» — мне должны, «взял» — должен я', () => {
  it('дал — плюс', () => {
    expect(signedLeft(loan({ id: 'loan-1' }), [])).toEqual({ amount: 500000, currency: 'RUB' })
  })

  it('взял — минус', () => {
    expect(signedLeft(loan({ id: 'loan-1', direction: 'borrowed' }), [])).toEqual({
      amount: -500000,
      currency: 'RUB',
    })
  })
})

describe('чужая валюта не пересчитывается молча (Р-04)', () => {
  it('возврат в другой валюте в остаток не входит', () => {
    const other = repayment({ id: 'r1', money: { amount: 5000, currency: 'USD' } })
    expect(loanState(loan({ id: 'loan-1' }), [other]).left).toBe(500000)
  })

  it('но и не пропадает — его называют отдельно', () => {
    const other = repayment({ id: 'r1', money: { amount: 5000, currency: 'USD' } })
    expect(foreignRepayments([other], loan({ id: 'loan-1' }))).toHaveLength(1)
  })
})

describe('кривой долг называется, а не проглатывается', () => {
  it('сходится — проблемы нет', () => {
    expect(loanProblem(loan({ id: 'loan-1' }))).toBeNull()
    expect(repaymentProblem(repayment({ id: 'r1' }), loan({ id: 'loan-1' }), [])).toBeNull()
  })

  it('сумма долга ноль или дробная', () => {
    expect(loanProblem(loan({ id: 'loan-1', money: { amount: 0, currency: 'RUB' } }))).toBe(
      'Сумма долга должна быть целой и больше нуля',
    )
    expect(loanProblem(loan({ id: 'loan-1', money: { amount: 10.5, currency: 'RUB' } }))).toBe(
      'Сумма долга должна быть целой и больше нуля',
    )
  })

  it('не сказано, с кем долг', () => {
    expect(loanProblem(loan({ id: 'loan-1', personId: '' }))).toBe('Не сказано, с кем долг')
  })

  it('возврат в чужой валюте — названы обе', () => {
    expect(
      repaymentProblem(
        repayment({ id: 'r1', money: { amount: 5000, currency: 'USD' } }),
        loan({ id: 'loan-1' }),
        [],
      ),
    ).toBe('Долг в RUB, а возврат в USD')
  })

  it('возвращают больше, чем брали, — на сколько именно', () => {
    const already = repayment({ id: 'r1', money: { amount: 400000, currency: 'RUB' } })
    expect(
      repaymentProblem(repayment({ id: 'r2' }), loan({ id: 'loan-1' }), [already]),
    ).toBe('Возвращают больше, чем брали, на 100000')
  })

  it('правка уже записанного возврата себя же не считает дважды', () => {
    const saved = repayment({ id: 'r1', money: { amount: 500000, currency: 'RUB' } })
    const edited = { ...saved, money: { amount: 400000, currency: 'RUB' } }
    expect(repaymentProblem(edited, loan({ id: 'loan-1' }), [saved])).toBeNull()
  })
})
