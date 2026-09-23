/**
 * Сверка переноса листов капитала и сборка файла импорта (План, Этап 4, п. 5; Р-34).
 *
 * Отвечает на один вопрос: сошёлся ли перенос листов «Банк_счета»,
 * «Пассивы», «Инвестиции», «Активы» и «Итоговое» с самой таблицей. Пока
 * не сошёлся — переносить нечего.
 *
 * Проверок четыре рода; последний — два уровня сверки, которые назвал Р-34:
 *
 * 1. **Листы между собой.** Слагаемые каждого листа против его «Суммы»;
 *    «Банк счета» «Пассивов» против «Банк_счета»; «Инвестиции» «Активов»
 *    против листа «Инвестиции»; «Итоговое» против двух листов. Ловит
 *    опечатку при переписывании со снимка;
 * 2. **Курсы воспроизводят итог «Пассивов».** Цена BTC и курс EUR жили
 *    внутри формулы; если восстановленные курсы не дают итог листа до
 *    рубля — восстановлены неверно;
 * 3. **Файл самодостаточен.** Он прогоняется через настоящий `planImport`
 *    приложения на пустой базе: ни одного отказа — иначе человек получит
 *    их на экране, как с первым файлом истории (Журнал 20.09.2026);
 * 4. **Капитал приложения против таблицы.** Из того, что запишет импорт,
 *    капитал считается настоящим `capitalOn` — тем же кодом, что на экране.
 *    Сбережения обязаны совпасть с «Пассивами», вложения — с «Инвестициями»,
 *    по рублю; итог — с «Итоговым» за вычетом стипендии и отложенного
 *    платежа, и обе поправки называются суммой (Р-34, Р-35).
 *
 * Данные — только в `seed/`, под `.gitignore` (CLAUDE.md, «Личные данные»).
 * Здесь — только правила сверки и ни одного числа из таблицы.
 *
 * Запуск: `npm run capital`. Падает с кодом 1, если хоть одна проверка
 * не сошлась; при удаче кладёт рядом файл `zloty-import` для экрана загрузки.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYNCED_STORES } from '../src/app/model.ts'
import { capitalOn } from '../src/modules/capital/capital.ts'
import { planImport } from '../src/registry.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'seed', 'капитал-листы.json')
const TARGET = join(ROOT, 'seed', 'zloty-капитал.json')

/** Сколько рублей расхождения терпит сверка: итоги листа округлены до десятых, позиции — до копеек. */
const RUB_TOLERANCE = 1
/** Итог листа в долларах записан с шестью знаками: сравнивается до цента. */
const USD_TOLERANCE = 0.01

const checks = []
function check(what, passed, seen = '') {
  checks.push({ what, passed, seen })
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance
const rub = (value) => `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`
const round2 = (value) => Math.round(value * 100) / 100

const sheets = JSON.parse(readFileSync(SOURCE, 'utf8'))
const byDate = (rows) => new Map(rows.map((row) => [row.date, row]))

const banks = byDate(sheets.banks.rows)
const values = byDate(sheets.values.rows)
const investments = byDate(sheets.investments.rows)
const assets = byDate(sheets.assets.rows)
const summary = byDate(sheets.summary.rows)

// ─── 1. Листы между собой ───────────────────────────────────────────────────

for (const [name, map] of [['Банк_счета', banks], ['Пассивы', values], ['Инвестиции', investments], ['Активы', assets], ['Итоговое', summary]]) {
  const missing = sheets.dates.filter((date) => !map.has(date))
  check(`«${name}»: строки на все даты переноса`, missing.length === 0, missing.join(', '))
}

for (const date of sheets.dates) {
  const bank = banks.get(date)
  const value = values.get(date)
  const invest = investments.get(date)
  const asset = assets.get(date)
  const total = summary.get(date)
  if (!bank || !value || !invest || !asset || !total) continue

  const banksSum = bank.values.reduce((all, each) => all + each, 0)
  check(`${date} «Банк_счета»: банки дают «Сумму»`, near(banksSum, bank.sum, 0), `${banksSum} против ${bank.sum}`)
  check(`${date} «Пассивы»: «Банк счета» = «Банк_счета»`, value.bank === bank.sum, `${value.bank} против ${bank.sum}`)

  const investSum = invest.values.reduce((all, each) => all + each, 0)
  check(`${date} «Инвестиции»: площадки дают «Сумму»`, near(investSum, invest.sum, 1e-9), `${investSum} против ${invest.sum}`)
  check(`${date} «Активы»: «Инвестиции» = лист «Инвестиции»`, asset.investments === invest.sum, `${asset.investments} против ${invest.sum}`)
  check(`${date} «Активы»: стипендия + вложения = «Сумма»`, near(asset.stipend + asset.investments, asset.sum, 1e-9), `${asset.sum}`)

  check(`${date} «Итоговое»: пассивы = «Пассивы» в ₽`, near(total.savings, value.sumRub, 1e-9), `${total.savings} против ${value.sumRub}`)
  check(`${date} «Итоговое»: активы = «Активы»`, near(total.assets, asset.sum, 1e-9), `${total.assets} против ${asset.sum}`)
  check(`${date} «Итоговое»: пассивы + активы = сумма`, near(total.savings + total.assets, total.total, 0.1), `${total.savings + total.assets} против ${total.total}`)
}

// ─── 2. Курсы воспроизводят итог «Пассивов» ────────────────────────────────

/** Курсы на дату: доллар — из клетки или скрытый; BTC и EUR — из формулы (Р-34). */
function ratesOn(row) {
  const hidden = sheets.hiddenRates.byDate[row.date]
  const from = sheets.hiddenRates.from
  const usdRub = row.rate ?? hidden?.usdRub
  const eurUsd = hidden?.eurUsd ?? (row.date >= from.date ? from.eurUsd : null)
  let btcUsd = hidden ? hidden.btcUsd : row.date >= from.date ? from.btcUsd : null
  if (btcUsd === null && usdRub && eurUsd) {
    // Подгонка под итог — по указанию человека (Р-34): EUR настоящий, BTC — остаток.
    const rest = row.sumUsd - row.usd - row.eur * eurUsd - (row.cash + row.bank) / usdRub
    btcUsd = round2(rest / (row.mbtc / 1000))
  }
  return { usdRub, eurUsd, btcUsd }
}

const rateByDate = new Map()
for (const date of sheets.dates) {
  const row = values.get(date)
  if (!row) continue
  const { usdRub, eurUsd, btcUsd } = ratesOn(row)
  const known = usdRub && eurUsd && btcUsd
  check(`${date} курсы известны: USD→RUB, EUR→USD, BTC→USD`, Boolean(known), `${usdRub} · ${eurUsd} · ${btcUsd}`)
  if (!known) continue
  rateByDate.set(date, { usdRub, eurUsd, btcUsd })

  const usd = row.usd + row.eur * eurUsd + (row.mbtc / 1000) * btcUsd + (row.cash + row.bank) / usdRub
  check(`${date} «Пассивы»: курсы дают итог в USD`, near(usd, row.sumUsd, USD_TOLERANCE), `${usd.toFixed(6)} против ${row.sumUsd}`)
  check(`${date} «Пассивы»: и итог в ₽`, near(usd * usdRub, row.sumRub, RUB_TOLERANCE), `${rub(usd * usdRub)} против ${rub(row.sumRub)}`)
}

// ─── Сборка файла импорта ──────────────────────────────────────────────────

const names = sheets.accounts
const card = sheets.creditCard
const invest = Object.entries(names.investments)

const file = {
  format: 'zloty-import',
  version: 1,
  currencies: [
    { code: 'RUB', name: 'Рубль', decimals: 2 },
    { code: 'USD', name: 'Доллар', decimals: 2 },
    { code: 'EUR', name: 'Евро', decimals: 2 },
    { code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 } },
  ],
  accounts: [
    // Счета учёта уже в базе: повтор по имени импорт пропустит. Объявлены,
    // чтобы файл был самодостаточен и на пустой базе.
    ...names.existing.map((name) => ({ name, currency: 'RUB', kind: 'savings' })),
    ...Object.entries(names.cash).map(([currency, name]) => ({ name, currency, kind: 'savings' })),
    { name: names.wallet, currency: 'BTC', kind: 'savings' },
    ...invest.map(([name, currency]) => ({ name, currency, kind: 'investment' })),
  ],
  rates: [],
  balances: [],
  notes: sheets.comments.map((each) => ({ date: each.date, text: `«${each.sheet}»: ${each.text}` })),
}

for (const date of sheets.dates) {
  const rates = rateByDate.get(date)
  const bank = banks.get(date)
  const value = values.get(date)
  const investRow = investments.get(date)
  if (!rates || !bank || !value || !investRow) continue

  file.rates.push(
    { date, from: 'USD', to: 'RUB', rate: rates.usdRub },
    { date, from: 'EUR', to: 'USD', rate: rates.eurUsd },
    { date, from: 'BTC', to: 'USD', rate: rates.btcUsd },
  )

  sheets.banks.columns.forEach((name, index) => {
    const amount = bank.values[index]
    if (name === card.account && date >= card.from) {
      file.balances.push({ account: name, date, part: card.mainPart, amount })
      file.balances.push({ account: name, date, part: card.part, amount: card.amount, deferred: true })
    } else {
      file.balances.push({ account: name, date, amount })
    }
  })
  file.balances.push(
    { account: names.cash.RUB, date, amount: value.cash },
    { account: names.cash.USD, date, amount: value.usd },
    { account: names.cash.EUR, date, amount: value.eur },
    { account: names.wallet, date, amount: value.mbtc / 1000 },
  )
  sheets.investments.columns.forEach((name, index) => {
    const amount = investRow.values[index]
    const currency = names.investments[name]
    // Polymarket — в долларах (Р-34): рубли листа делятся на курс листа, до цента.
    file.balances.push({ account: name, date, amount: currency === 'USD' ? round2(amount / rates.usdRub) : amount })
  })
}

// ─── 3. Файл самодостаточен: настоящий импорт на пустой базе ───────────────

const empty = Object.fromEntries(SYNCED_STORES.map((store) => [store, []]))
let seq = 0
const plan = planImport(JSON.stringify(file), empty, { newId: () => `check-${++seq}`, now: new Date().toISOString() })
check(
  'файл проходит импорт приложения на пустой базе без единого отказа',
  plan.issues.length === 0,
  plan.issues.map((each) => `${each.title}: ${each.reason}`).join(' · '),
)
check('все снимки дошли до записи', (plan.writes.balances ?? []).length === file.balances.length, `${(plan.writes.balances ?? []).length} из ${file.balances.length}`)

// ─── 4. Капитал приложения против таблицы ──────────────────────────────────

const data = {
  accounts: plan.writes.accounts ?? [],
  balances: plan.writes.balances ?? [],
  rates: plan.writes.rates ?? [],
  currencies: plan.writes.currencies ?? [],
  base: 'RUB',
}

const minor = (amount) => amount / 100
const corrections = []
for (const date of sheets.dates) {
  const value = values.get(date)
  const investRow = investments.get(date)
  const asset = assets.get(date)
  const total = summary.get(date)
  if (!value || !investRow || !asset || !total) continue

  const capital = capitalOn(data, date)
  check(`${date} капитал: все позиции с курсом`, capital.missing.length === 0 && capital.without.length === 0,
    [...capital.missing.map((each) => `нет курса ${each.currency}`), ...capital.without.map((each) => `без снимка ${each.name}`)].join(', '))
  check(`${date} сбережения приложения = «Пассивы» в ₽`, near(minor(capital.savings), value.sumRub, RUB_TOLERANCE),
    `${rub(minor(capital.savings))} против ${rub(value.sumRub)}`)
  check(`${date} вложения приложения = «Инвестиции»`, near(minor(capital.investments), investRow.sum, RUB_TOLERANCE),
    `${rub(minor(capital.investments))} против ${rub(investRow.sum)}`)

  const deferred = date >= card.from ? card.amount : 0
  check(`${date} отложенный платёж — кредитка с ${card.from}`, near(minor(capital.deferred), deferred, 0), rub(minor(capital.deferred)))

  const expected = total.total - asset.stipend - deferred
  check(`${date} капитал = «Итоговое» − стипендия − отложенный платёж`, near(minor(capital.total), expected, RUB_TOLERANCE),
    `${rub(minor(capital.total))} против ${rub(expected)}`)
  corrections.push({ date, sheet: total.total, app: minor(capital.total), stipend: asset.stipend, deferred })
}

// ─── Итог ──────────────────────────────────────────────────────────────────

const failed = checks.filter((each) => !each.passed)
for (const each of checks) {
  console.log(`${each.passed ? '  ok' : 'НЕТ '} ${each.what}${each.seen ? ` — ${each.seen}` : ''}`)
}

console.log('\nПоправки к «Итоговому» — капитал приложения меньше таблицы ровно на них (Р-34, Р-35):')
for (const each of corrections) {
  const parts = [`стипендия ${rub(each.stipend)}`]
  if (each.deferred) parts.push(`отложенный платёж ${rub(each.deferred)}`)
  console.log(`  ${each.date}: таблица ${rub(each.sheet)} → приложение ${rub(each.app)} (${parts.join(', ')})`)
}

if (failed.length > 0) {
  console.log(`\nСверка не сошлась: проверок ${checks.length}, не сошлось ${failed.length}. Файл не собран.`)
  process.exit(1)
}

writeFileSync(TARGET, `${JSON.stringify(file, null, 2)}\n`)
console.log(
  `\nСверка сошлась: ${checks.length} проверок. Файл — ${TARGET}: ` +
    `счетов — ${file.accounts.length}, снимков — ${file.balances.length}, курсов — ${file.rates.length}, заметок — ${file.notes.length}.`,
)
