import { describe, expect, it } from 'vitest'
import type { Loan, Person, Repayment } from '../../app/model.ts'
import { loanGroups } from './loanGroups.ts'

/** Люди выдуманные: код публичный (CLAUDE.md). */
const at = '2026-09-22T10:00:00.000Z'
const ANYA = 'person-anya'
const BORYA = 'person-borya'
const VERA = 'person-vera'
const GLEB = 'person-gleb'

const people: Person[] = [
  { id: VERA, updatedAt: at, name: 'Вера' },
  { id: GLEB, updatedAt: at, name: 'Глеб', starred: true },
  { id: BORYA, updatedAt: at, name: 'Боря' },
  { id: ANYA, updatedAt: at, name: 'Аня', self: true },
]

function loan(over: Partial<Loan> & { id: string }): Loan {
  return {
    updatedAt: at,
    personId: BORYA,
    direction: 'lent',
    money: { amount: 500000, currency: 'RUB' },
    date: '2026-08-10',
    ...over,
  }
}

function repayment(over: Partial<Repayment> & { id: string; loanId: string }): Repayment {
  return {
    updatedAt: at,
    money: { amount: 200000, currency: 'RUB' },
    date: '2026-09-01',
    ...over,
  }
}

describe('разовые долги — группами по человеку (Р-58)', () => {
  it('долги одного человека — в одной группе, даже если долг один', () => {
    const groups = loanGroups(people, [
      loan({ id: 'l1' }),
      loan({ id: 'l2', personId: VERA }),
      loan({ id: 'l3' }),
    ], [])
    expect(groups.map((each) => each.personId)).toEqual([BORYA, VERA])
    expect(groups[0]?.loans.map((each) => each.id)).toEqual(['l1', 'l3'])
    expect(groups[1]?.loans.map((each) => each.id)).toEqual(['l2'])
  })

  it('порядок групп — «я», важные, остальные по алфавиту', () => {
    const groups = loanGroups(people, [
      loan({ id: 'l1', personId: VERA }),
      loan({ id: 'l2', personId: BORYA }),
      loan({ id: 'l3', personId: GLEB }),
      loan({ id: 'l4', personId: ANYA }),
    ], [])
    expect(groups.map((each) => each.personId)).toEqual([ANYA, GLEB, BORYA, VERA])
  })

  it('человек в архиве или удалённый не теряет группу — она в конце', () => {
    const gone: Person[] = [...people, { id: 'person-dima', updatedAt: at, name: 'Дима', archived: true }]
    const groups = loanGroups(gone, [
      loan({ id: 'l1', personId: 'person-dima' }),
      loan({ id: 'l2', personId: VERA }),
    ], [])
    expect(groups.map((each) => each.personId)).toEqual([VERA, 'person-dima'])
  })

  it('внутри группы — по дате долга, старые выше', () => {
    const groups = loanGroups(people, [
      loan({ id: 'l1', date: '2026-09-15' }),
      loan({ id: 'l2', date: '2026-07-01' }),
      loan({ id: 'l3', date: '2026-08-20' }),
    ], [])
    expect(groups[0]?.loans.map((each) => each.id)).toEqual(['l2', 'l3', 'l1'])
  })
})

describe('итог группы — по валютам, тем же правилом, что «Кто кому должен»', () => {
  it('остаток после возвратов, со знаком: дал — плюс, взял — минус', () => {
    const groups = loanGroups(people, [
      loan({ id: 'l1' }),
      loan({ id: 'l2', personId: VERA, direction: 'borrowed', money: { amount: 150000, currency: 'RUB' } }),
    ], [repayment({ id: 'r1', loanId: 'l1' })])
    expect(groups[0]?.amounts).toEqual([{ amount: 300000, currency: 'RUB' }])
    expect(groups[1]?.amounts).toEqual([{ amount: -150000, currency: 'RUB' }])
  })

  it('валюты не складываются: две строки', () => {
    const groups = loanGroups(people, [
      loan({ id: 'l1' }),
      loan({ id: 'l2', money: { amount: 10000, currency: 'USD' } }),
    ], [])
    expect(groups[0]?.amounts).toEqual([
      { amount: 500000, currency: 'RUB' },
      { amount: 10000, currency: 'USD' },
    ])
  })

  it('встречные долги одного человека в одной валюте сводятся, как в «Кто кому должен»', () => {
    const groups = loanGroups(people, [
      loan({ id: 'l1' }),
      loan({ id: 'l2', direction: 'borrowed', money: { amount: 200000, currency: 'RUB' } }),
    ], [])
    expect(groups[0]?.amounts).toEqual([{ amount: 300000, currency: 'RUB' }])
    expect(groups[0]?.loans).toHaveLength(2)
  })
})

describe('закрытые и удалённые долги в группы не идут', () => {
  it('удалённый долг — нет группы', () => {
    expect(loanGroups(people, [loan({ id: 'l1', deleted: true })], [])).toEqual([])
  })

  it('вернули всё — долг закрыт и в группу не идёт', () => {
    const groups = loanGroups(people, [
      loan({ id: 'l1' }),
      loan({ id: 'l2', money: { amount: 200000, currency: 'RUB' } }),
    ], [repayment({ id: 'r1', loanId: 'l2' })])
    expect(groups[0]?.loans.map((each) => each.id)).toEqual(['l1'])
    expect(groups[0]?.amounts).toEqual([{ amount: 500000, currency: 'RUB' }])
  })

  it('все долги человека закрыты — группы нет', () => {
    const groups = loanGroups(people, [loan({ id: 'l1', money: { amount: 200000, currency: 'RUB' } })], [
      repayment({ id: 'r1', loanId: 'l1' }),
    ])
    expect(groups).toEqual([])
  })
})
