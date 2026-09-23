import { describe, expect, it } from 'vitest'
import type { RoomSpend } from '../../app/model.ts'
import { shareOf, sharesOf, spendProblem, splitMode } from './split.ts'

/** Люди выдуманные: код публичный (CLAUDE.md). */
const ANYA = 'person-anya'
const BORYA = 'person-borya'
const VERA = 'person-vera'

function spend(over: Partial<RoomSpend> = {}): RoomSpend {
  return {
    id: 'spend-1',
    updatedAt: '2026-09-22T10:00:00.000Z',
    eventId: 'event-1',
    date: '2026-08-21',
    title: 'Корт',
    payerId: ANYA,
    amount: 300000,
    split: [{ personId: ANYA }, { personId: BORYA }, { personId: VERA }],
    ...over,
  }
}

const sum = (shares: Map<string, number>) => [...shares.values()].reduce((a, b) => a + b, 0)

describe('доли делятся целым — дробных сумм в модели нет (Р-04)', () => {
  it('3 000 ₽ на троих — по 1 000 каждому, без остатка', () => {
    const shares = sharesOf(spend())
    expect(shares.get(ANYA)).toBe(100000)
    expect(shares.get(BORYA)).toBe(100000)
    expect(shares.get(VERA)).toBe(100000)
  })

  it('1 000 ₽ на троих — остаток достаётся плательщику (Р-30)', () => {
    const shares = sharesOf(spend({ amount: 100000 }))
    expect(shares.get(ANYA)).toBe(33334)
    expect(shares.get(BORYA)).toBe(33333)
    expect(shares.get(VERA)).toBe(33333)
    expect(sum(shares)).toBe(100000)
  })

  it('плательщика среди делящих нет — остаток идёт первому в списке', () => {
    const shares = sharesOf(
      spend({ amount: 100000, payerId: ANYA, split: [{ personId: BORYA }, { personId: VERA }] }),
    )
    expect(shares.get(BORYA)).toBe(50000)
    expect(shares.get(VERA)).toBe(50000)

    const odd = sharesOf(
      spend({ amount: 100001, payerId: ANYA, split: [{ personId: BORYA }, { personId: VERA }] }),
    )
    expect(odd.get(BORYA)).toBe(50001)
    expect(odd.get(VERA)).toBe(50000)
    expect(sum(odd)).toBe(100001)
  })

  it('сумма долей равна сумме траты всегда — сколько бы ни делили', () => {
    for (const amount of [1, 2, 7, 99, 100000, 100001, 999999]) {
      for (const people of [1, 2, 3, 5, 7]) {
        const split = [ANYA, BORYA, VERA, 'd', 'e', 'f', 'g']
          .slice(0, people)
          .map((personId) => ({ personId }))
        expect(sum(sharesOf(spend({ amount, split })))).toBe(amount)
      }
    }
  })
})

describe('заданная доля — сумма, а не вес (Р-30)', () => {
  it('у кого задана — берёт своё, остальное делится поровну', () => {
    const shares = sharesOf(
      spend({
        amount: 100000,
        split: [{ personId: ANYA }, { personId: BORYA, share: 70000 }, { personId: VERA }],
      }),
    )
    expect(shares.get(BORYA)).toBe(70000)
    expect(shares.get(ANYA)).toBe(15000)
    expect(shares.get(VERA)).toBe(15000)
  })

  it('заданы у всех — каждый берёт ровно своё', () => {
    const shares = sharesOf(
      spend({
        amount: 100000,
        split: [
          { personId: ANYA, share: 20000 },
          { personId: BORYA, share: 50000 },
          { personId: VERA, share: 30000 },
        ],
      }),
    )
    expect(shares.get(ANYA)).toBe(20000)
    expect(shares.get(BORYA)).toBe(50000)
    expect(shares.get(VERA)).toBe(30000)
  })

  it('доля 0 — законна: человек был, но за него не платили', () => {
    const shares = sharesOf(
      spend({ amount: 100000, split: [{ personId: ANYA }, { personId: BORYA, share: 0 }] }),
    )
    expect(shares.get(BORYA)).toBe(0)
    expect(shares.get(ANYA)).toBe(100000)
  })

  it('своя доля того, кого в трате нет, — ноль, а не ошибка', () => {
    expect(shareOf(spend(), 'person-gleb')).toBe(0)
  })
})

describe('кривая трата называется, а не проглатывается', () => {
  it('сходится — проблемы нет', () => {
    expect(spendProblem(spend())).toBeNull()
  })

  it('не сказано, на кого делится', () => {
    expect(spendProblem(spend({ split: [] }))).toBe('Не сказано, на кого делится трата')
  })

  it('сумма ноль или дробная', () => {
    expect(spendProblem(spend({ amount: 0 }))).toBe('Сумма траты должна быть целой и больше нуля')
    expect(spendProblem(spend({ amount: 1000.5 }))).toBe('Сумма траты должна быть целой и больше нуля')
  })

  it('один человек в долях дважды', () => {
    expect(spendProblem(spend({ split: [{ personId: ANYA }, { personId: ANYA }] }))).toBe(
      'Один человек в долях дважды',
    )
  })

  it('доли больше траты — на сколько именно', () => {
    expect(
      spendProblem(spend({ amount: 100000, split: [{ personId: ANYA, share: 150000 }] })),
    ).toBe('Доли больше траты на 50000')
  })

  it('заданы все, а до суммы не хватает — хвост без хозяина', () => {
    expect(
      spendProblem(
        spend({
          amount: 100000,
          split: [{ personId: ANYA, share: 30000 }, { personId: BORYA, share: 30000 }],
        }),
      ),
    ).toBe('Доли меньше траты на 40000')
  })

  it('на кривой трате доли всё равно сходятся с суммой — расход не теряется', () => {
    const broken = spend({
      amount: 100000,
      split: [{ personId: ANYA, share: 30000 }, { personId: BORYA, share: 30000 }],
    })
    expect(spendProblem(broken)).not.toBeNull()
    expect(sum(sharesOf(broken))).toBe(100000)
  })
})

describe('доля весом — «Боре две порции, Вере одна» (Р-33)', () => {
  it('3 000 ₽ весами 2 : 1 : 1 — 1 500, 750 и 750', () => {
    const shares = sharesOf(
      spend({
        split: [{ personId: ANYA }, { personId: BORYA, weight: 2 }, { personId: VERA }],
        payerId: VERA,
      }),
    )
    expect(shares.get(BORYA)).toBe(150000)
    expect(shares.get(ANYA)).toBe(75000)
    expect(shares.get(VERA)).toBe(75000)
  })

  it('вес может быть дробным: полторы порции против одной', () => {
    const shares = sharesOf(
      spend({ amount: 250000, split: [{ personId: ANYA, weight: 1.5 }, { personId: BORYA, weight: 1 }] }),
    )
    expect(shares.get(ANYA)).toBe(150000)
    expect(shares.get(BORYA)).toBe(100000)
  })

  it('на неделящейся сумме доли всё равно целые, и копейка — плательщику', () => {
    const shares = sharesOf(
      spend({
        amount: 100000,
        payerId: BORYA,
        split: [{ personId: ANYA, weight: 1 }, { personId: BORYA, weight: 1 }, { personId: VERA, weight: 1 }],
      }),
    )
    expect(shares.get(BORYA)).toBe(33334)
    expect(sum(shares)).toBe(100000)
    expect([...shares.values()].every(Number.isInteger)).toBe(true)
  })

  it('вес ноль — человек в трате, но ничего не должен', () => {
    const shares = sharesOf(spend({ split: [{ personId: ANYA }, { personId: BORYA, weight: 0 }] }))
    expect(shares.get(BORYA)).toBe(0)
    expect(shares.get(ANYA)).toBe(300000)
  })

  it('сумма и вес вместе: «взял на 700», остальное — по весам', () => {
    const shares = sharesOf(
      spend({
        amount: 370000,
        split: [
          { personId: ANYA, share: 70000 },
          { personId: BORYA, weight: 2 },
          { personId: VERA, weight: 1 },
        ],
      }),
    )
    expect(shares.get(ANYA)).toBe(70000)
    expect(shares.get(BORYA)).toBe(200000)
    expect(shares.get(VERA)).toBe(100000)
  })

  it('старая трата без весов считается ровно как раньше — поровну', () => {
    const before = sharesOf(spend({ amount: 100000 }))
    const withOnes = sharesOf(
      spend({
        amount: 100000,
        split: [{ personId: ANYA, weight: 1 }, { personId: BORYA, weight: 1 }, { personId: VERA, weight: 1 }],
      }),
    )
    expect([...withOnes]).toEqual([...before])
  })

  it('сумма долей равна сумме траты на любых весах', () => {
    for (const amount of [1, 7, 99, 100001, 999999]) {
      for (const weights of [[1, 2], [0.5, 1.5, 3], [3, 3, 1, 7]]) {
        const split = weights.map((weight, index) => ({ personId: `p${index}`, weight }))
        expect(sum(sharesOf(spend({ amount, split, payerId: 'p0' })))).toBe(amount)
      }
    }
  })
})

describe('кривые веса называются', () => {
  it('у одного человека и сумма, и вес — нужно что-то одно', () => {
    expect(spendProblem(spend({ split: [{ personId: ANYA, share: 100, weight: 2 }, { personId: BORYA }] }))).toBe(
      'У одного человека и сумма, и вес — нужно что-то одно',
    )
  })

  it('отрицательный вес', () => {
    expect(spendProblem(spend({ split: [{ personId: ANYA, weight: -1 }, { personId: BORYA }] }))).toBe(
      'Вес должен быть числом не меньше нуля',
    )
  })

  it('все веса нулевые — остаток делить не на кого', () => {
    expect(
      spendProblem(spend({ split: [{ personId: ANYA, weight: 0 }, { personId: BORYA, weight: 0 }] })),
    ).toBe('Все веса нулевые — остаток делить не на кого')
  })

  it('на нулевых весах сумма долей всё равно сходится — расход не теряется', () => {
    const broken = spend({ split: [{ personId: ANYA, weight: 0 }, { personId: BORYA, weight: 0 }] })
    expect(sum(sharesOf(broken))).toBe(300000)
  })
})

describe('способ деления для подписи на экране', () => {
  it('без сумм и весов — поровну', () => {
    expect(splitMode(spend())).toBe('equal')
  })

  it('веса, все по одному, — тоже поровну', () => {
    expect(splitMode(spend({ split: [{ personId: ANYA, weight: 1 }, { personId: BORYA, weight: 1 }] }))).toBe('equal')
  })

  it('хоть один вес не единица — весами', () => {
    expect(splitMode(spend({ split: [{ personId: ANYA, weight: 2 }, { personId: BORYA }] }))).toBe('weights')
  })

  it('хоть одна сумма — суммами', () => {
    expect(splitMode(spend({ split: [{ personId: ANYA, share: 100 }, { personId: BORYA, weight: 2 }] }))).toBe(
      'amounts',
    )
  })
})
