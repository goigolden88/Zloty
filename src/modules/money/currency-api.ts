/**
 * Публичный источник курсов — `currency-api` (fawazahmed0) на jsDelivr, без
 * ключа (Р-38). Запасной адрес того же проекта — `currency-api.pages.dev`.
 *
 * **Источник живёт этим одним файлом.** Он умеет две вещи: сказать, какие
 * адреса спросить, и превратить ответ в раздел `rates` формата
 * `zloty-import`. Дальше ответ идёт той же дорогой, что выписка: проверка,
 * сводка, запись по кнопке (Р-09). Поменять источник — написать такой же
 * файл и сменить одну строку, где он подключён.
 *
 * Курс рыночный, а не ЦБ: около 0,4% разницы у рубля (Р-38, «Цена»).
 */

import type { CurrencyCode } from '../../app/model.ts'

/** Имя источника: ложится в `Rate.source`. */
export const RATE_SOURCE = 'currency-api'

/** Сколько ждать ответа одного адреса, прежде чем пробовать запасной. */
export const RATE_TIMEOUT_MS = 10_000

/**
 * Адреса на дату — основной и запасной. Сегодня файла на дату может ещё не
 * быть — источник выкладывает его раз в сутки, — поэтому сегодня спрашивается
 * `latest`, а дата берётся из ответа.
 */
export function rateUrls(date: string | 'latest', base: CurrencyCode): string[] {
  const code = base.toLowerCase()
  return [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${code}.min.json`,
    `https://${date}.currency-api.pages.dev/v1/currencies/${code}.min.json`,
  ]
}

/** Строка раздела `rates` формата импорта. */
export type RateLine = { date: string; from: CurrencyCode; to: CurrencyCode; rate: number; source: string }

/**
 * Ответ источника → курсы валют к базовой.
 *
 * Источник отвечает «сколько единиц X за одну базовую»: `{ date, rub: { usd:
 * 0.0116, btc: 0.00000015 } }`. В базу пишется обратное — «сколько базовой
 * за один X», `USD→RUB 86,3`: так курс и называют, и так его вносит человек.
 * Каждая строка — прямой курс к базовой, промежуточная валюта ему не нужна (Р-37).
 * Валюты, которой в ответе нет, — в `missing`: её не выдумывают.
 */
export function parseRates(
  body: unknown,
  base: CurrencyCode,
  codes: readonly CurrencyCode[],
): { date: string; lines: RateLine[]; missing: CurrencyCode[] } | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  const date = typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? record.date : null
  const table = record[base.toLowerCase()]
  if (!date || typeof table !== 'object' || table === null) return null

  const values = table as Record<string, unknown>
  const lines: RateLine[] = []
  const missing: CurrencyCode[] = []
  for (const code of codes) {
    if (code === base) continue
    const per = values[code.toLowerCase()]
    if (typeof per !== 'number' || !(per > 0) || !Number.isFinite(1 / per)) {
      missing.push(code)
      continue
    }
    lines.push({ date, from: code, to: base, rate: 1 / per, source: RATE_SOURCE })
  }
  return { date, lines, missing }
}

export type Fetched = {
  /** Файл `zloty-import` с разделом `rates` — для той же проверки и сводки, что у выписки. */
  file: string
  lines: RateLine[]
  /** Что не получилось: дата и почему. */
  failed: { date: string; reason: string }[]
  /** Валюты, которых нет в ответе источника. */
  missing: CurrencyCode[]
}

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

async function ask(url: string, fetcher: Fetcher, timeout: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetcher(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`ответ ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Спросить курсы на даты: основной адрес, не ответил — запасной. В базу
 * ничего не пишет: отдаёт файл импорта, запись — по кнопке человека (Р-09).
 */
export async function fetchRates(
  dates: readonly (string | 'latest')[],
  base: CurrencyCode,
  codes: readonly CurrencyCode[],
  fetcher: Fetcher = (url, init) => fetch(url, init),
  timeout: number = RATE_TIMEOUT_MS,
): Promise<Fetched> {
  const lines: RateLine[] = []
  const failed: Fetched['failed'] = []
  const missing = new Set<CurrencyCode>()

  for (const date of dates) {
    let parsed: ReturnType<typeof parseRates> = null
    let reason = 'источник не ответил'
    for (const url of rateUrls(date, base)) {
      try {
        parsed = parseRates(await ask(url, fetcher, timeout), base, codes)
        if (parsed) break
        reason = 'ответ источника не похож на курсы'
      } catch (failure) {
        reason = failure instanceof Error && failure.name === 'AbortError' ? 'источник не ответил вовремя' : 'источник не ответил'
      }
    }
    if (!parsed) {
      failed.push({ date: date === 'latest' ? 'сегодня' : date, reason })
      continue
    }
    for (const line of parsed.lines) {
      if (!lines.some((each) => each.date === line.date && each.from === line.from && each.to === line.to)) lines.push(line)
    }
    for (const code of parsed.missing) missing.add(code)
  }

  const file = JSON.stringify({ format: 'zloty-import', version: 1, rates: lines })
  return { file, lines, failed, missing: [...missing] }
}
