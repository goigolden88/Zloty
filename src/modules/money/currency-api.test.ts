import { describe, expect, it } from 'vitest'
import { fetchRates, parseRates, RATE_SOURCE, rateUrls } from './currency-api.ts'

/**
 * Образец ответа — в том виде, в каком его отдаёт источник (сокращён до трёх
 * валют; числа — рыночные курсы, личного в них нет).
 */
const SAMPLE = {
  date: '2026-09-01',
  rub: { usd: 0.0115849, eur: 0.00998, btc: 0.000000147, aed: 0.0425 },
}

describe('ответ источника → курсы к базовой (Р-38)', () => {
  it('источник говорит «X за один рубль», в базу — «рублей за один X»', () => {
    const parsed = parseRates(SAMPLE, 'RUB', ['RUB', 'USD', 'BTC'])
    expect(parsed?.date).toBe('2026-09-01')
    expect(parsed?.lines.map((each) => [each.from, each.to])).toEqual([
      ['USD', 'RUB'],
      ['BTC', 'RUB'],
    ])
    expect(parsed?.lines[0]?.rate).toBeCloseTo(86.32, 2)
    expect(parsed?.lines.every((each) => each.source === RATE_SOURCE)).toBe(true)
  })

  it('валюты, которой в ответе нет, — не выдумывает, а называет', () => {
    expect(parseRates(SAMPLE, 'RUB', ['USD', 'XYZ'])?.missing).toEqual(['XYZ'])
  })

  it('не похожее на курсы — null, а не пустой ответ', () => {
    expect(parseRates({ message: 'not found' }, 'RUB', ['USD'])).toBeNull()
    expect(parseRates('<html>', 'RUB', ['USD'])).toBeNull()
  })

  it('два адреса — основной и запасной; сегодня спрашивается latest', () => {
    const [main, spare] = rateUrls('latest', 'RUB')
    expect(main).toContain('cdn.jsdelivr.net')
    expect(main).toContain('@latest/')
    expect(main).toContain('/rub.min.json')
    expect(spare).toContain('latest.currency-api.pages.dev')
  })
})

const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body })
const down = async () => {
  throw new TypeError('Failed to fetch')
}

describe('запрос', () => {
  it('основной не ответил — берётся запасной', async () => {
    const asked: string[] = []
    const fetcher = async (url: string) => {
      asked.push(url)
      if (url.includes('jsdelivr')) return down()
      return ok(SAMPLE)()
    }
    const result = await fetchRates(['2026-09-01'], 'RUB', ['USD'], fetcher)
    expect(asked).toHaveLength(2)
    expect(result.failed).toEqual([])
    expect(result.lines).toHaveLength(1)
  })

  it('не ответил ни один — сказано словами, по какой дате', async () => {
    const result = await fetchRates(['2026-09-01', 'latest'], 'RUB', ['USD'], down)
    expect(result.failed).toEqual([
      { date: '2026-09-01', reason: 'источник не ответил' },
      { date: 'сегодня', reason: 'источник не ответил' },
    ])
    expect(result.lines).toEqual([])
  })

  it('ответ пришёл, но не курсы — это названо иначе, чем молчание', async () => {
    const result = await fetchRates(['2026-09-01'], 'RUB', ['USD'], ok({ message: 'not found' }))
    expect(result.failed[0]?.reason).toBe('ответ источника не похож на курсы')
  })

})
