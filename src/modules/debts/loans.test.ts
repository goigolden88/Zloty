import { describe, expect, it } from 'vitest'
import type { Loan, Repayment } from '../../app/model.ts'
import {
  foreignRepayments,
  lastRepayment,
  loanProblem,
  loanState,
  repaymentProblem,
  repaymentsOf,
  signedLeft,
} from './loans.ts'
import { removed, repayAll } from './records.ts'

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

describe('«Вернули всё» — возврат на весь остаток (Р-59)', () => {
  it('после частичного возврата пишется ровно остаток, и долг закрыт', () => {
    const debt = loan({ id: 'loan-1' })
    const before = [repayment({ id: 'r1' })]
    const whole = repayAll(debt, before, '2026-10-07')
    expect(whole).toMatchObject({ loanId: 'loan-1', money: { amount: 300000, currency: 'RUB' }, date: '2026-10-07' })
    expect(whole && repaymentProblem(whole, debt, before)).toBeNull()
    expect(loanState(debt, [...before, whole!]).closed).toBe(true)
  })

  it('валюта — долга, а не чужого возврата', () => {
    const debt = loan({ id: 'loan-1', money: { amount: 10000, currency: 'USD' } })
    const foreign = repayment({ id: 'r1', money: { amount: 5000, currency: 'RUB' } })
    expect(repayAll(debt, [foreign], '2026-10-07')?.money).toEqual({ amount: 10000, currency: 'USD' })
  })

  it('удалённый возврат в остаток не идёт', () => {
    const gone = repayment({ id: 'r1', deleted: true })
    expect(repayAll(loan({ id: 'loan-1' }), [gone], '2026-10-07')?.money.amount).toBe(500000)
  })

  it('закрытый долг — возвращать нечего', () => {
    const all = repayment({ id: 'r1', money: { amount: 500000, currency: 'RUB' } })
    expect(repayAll(loan({ id: 'loan-1' }), [all], '2026-10-07')).toBeNull()
  })
})

describe('«Открыть снова» снимает последний возврат и только его (Р-59)', () => {
  const debt = loan({ id: 'loan-1' })

  it('последний — по дате', () => {
    const late = repayment({ id: 'r2', date: '2026-09-20', updatedAt: '2026-09-01T10:00:00.000Z' })
    const early = repayment({ id: 'r1', date: '2026-09-01', updatedAt: '2026-09-25T10:00:00.000Z' })
    expect(lastRepayment(debt, [late, early])?.id).toBe('r2')
  })

  it('одной датой — по времени записи: частичный и следом «Вернули всё» — снимается второй', () => {
    const part = repayment({ id: 'r1', date: '2026-10-07', updatedAt: '2026-10-07T09:00:00.000Z' })
    const whole = repayment({
      id: 'r2',
      date: '2026-10-07',
      updatedAt: '2026-10-07T09:05:00.000Z',
      money: { amount: 300000, currency: 'RUB' },
    })
    const list = [whole, part]
    const last = lastRepayment(debt, list)
    expect(last?.id).toBe('r2')

    const after = list.map((each) => (each.id === last?.id ? removed(each) : each))
    expect(after.filter((each) => each.deleted).map((each) => each.id)).toEqual(['r2'])
    expect(loanState(debt, after)).toMatchObject({ left: 300000, closed: false })
  })

  it('удалённые и чужие возвраты не снимаются', () => {
    const live = repayment({ id: 'r1', date: '2026-09-01' })
    const gone = repayment({ id: 'r2', date: '2026-09-20', deleted: true })
    const other = repayment({ id: 'r3', date: '2026-09-25', loanId: 'loan-other' })
    const foreign = repayment({ id: 'r4', date: '2026-09-30', money: { amount: 5000, currency: 'USD' } })
    expect(lastRepayment(debt, [live, gone, other, foreign])?.id).toBe('r1')
  })

  it('снимать нечего — так и сказано', () => {
    expect(lastRepayment(debt, [])).toBeNull()
  })
})
