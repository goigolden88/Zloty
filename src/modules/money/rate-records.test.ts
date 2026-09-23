import { describe, expect, it } from 'vitest'
import type { Rate } from '../../app/model.ts'
import { rateProblem, ratesOn, rateWrite } from './rate-records.ts'

/** Курсы выдуманы: круглые числа, чтобы проверять правила, а не рынок. */
const AT = '2026-09-20T10:00:00.000Z'
const rate = (id: string, date: string, from: string, to: string, value: number, fields: Partial<Rate> = {}): Rate => ({
  id,
  updatedAt: AT,
  date,
  from,
  to,
  rate: value,
  source: 'import',
  ...fields,
})

const list = [rate('a', '2026-09-01', 'USD', 'RUB', 90), rate('b', '2026-09-01', 'BTC', 'USD', 50000)]

describe('курс руками', () => {
  it('новая пара на дату — новая запись с источником «manual»', () => {
    const made = rateWrite(list, { date: '2026-09-02', from: 'USD', to: 'RUB', rate: 91 })
    expect(made).toMatchObject({ date: '2026-09-02', from: 'USD', to: 'RUB', rate: 91, source: 'manual' })
    expect(made.id).not.toBe('a')
  })

  it('та же пара на ту же дату правится, а не заводится второй', () => {
    const made = rateWrite(list, { date: '2026-09-01', from: 'USD', to: 'RUB', rate: 92 })
    expect(made).toMatchObject({ id: 'a', rate: 92, source: 'manual' })
  })

  it('обратная пара на ту же дату — отказ: это тот же курс', () => {
    expect(rateProblem(list, { date: '2026-09-01', from: 'RUB', to: 'USD', rate: 0.011 })).toContain('USD→RUB')
  })

  it('курс не число, ноль, валюта к самой себе, нет даты — отказ', () => {
    expect(rateProblem(list, { date: '2026-09-01', from: 'EUR', to: 'RUB', rate: 0 })).toBe('курс — число больше нуля')
    expect(rateProblem(list, { date: '2026-09-01', from: 'EUR', to: 'RUB', rate: Number.NaN })).toBe('курс — число больше нуля')
    expect(rateProblem(list, { date: '2026-09-01', from: 'RUB', to: 'RUB', rate: 1 })).toContain('всегда единица')
    expect(rateProblem(list, { date: '', from: 'EUR', to: 'RUB', rate: 100 })).toBe('у курса нет даты')
  })

  it('курсы на дату — живые, по паре', () => {
    const withGone = [...list, rate('c', '2026-09-01', 'EUR', 'USD', 1.1, { deleted: true })]
    expect(ratesOn(withGone, '2026-09-01').map((each) => each.id)).toEqual(['b', 'a'])
  })
})
