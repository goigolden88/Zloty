/**
 * Сверка переноса истории и сборка файла импорта (План, Этап 1, п. 5).
 *
 * Отвечает на один вопрос: сошёлся ли перенос прежней таблицы с самой
 * таблицей. Пока не сошёлся — переносить нечего, и пункт не закрыт
 * (Р-08, Р-14).
 *
 * Сверяет три вещи, каждая ловит свою ошибку:
 *
 * 1. **Слагаемые против столбца «Сумма»** того же листа. Ловит опечатку
 *    при переписывании со снимка: ошибись в одном числе — не сойдётся;
 * 2. **«Сумма» против итогового листа** («Расходы за ласт месяц»). Ловит
 *    случай, когда со снимка переписана целая строка не оттуда;
 * 3. **Периоды идут подряд, без разрывов и без нахлёстов.** Ловит
 *    пропущенную строку — её иначе не заметить: суммы-то сойдутся.
 *
 * Данные — только в `seed/`, под `.gitignore`: в таблице видно, сколько
 * человек получает и на что тратит (CLAUDE.md, «Личные данные»). Здесь —
 * только правила сверки, и ни одного числа из таблицы.
 *
 * Запуск: `npm run history`. Падает с кодом 1, если хоть одна проверка
 * не сошлась; при удаче кладёт рядом файл `zloty-import` для экрана
 * «Загрузить выписку».
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'seed', 'история-расходов.json')
const TARGET = join(ROOT, 'seed', 'zloty-история.json')

/** Строка формата «ЗАПИСЬ ЗА ПЕРИОД» — та же, что у импорта приложения. */
const FORMAT = 'zloty-import'

const problems = []
const checks = []

function check(what, passed, seen = '') {
  checks.push({ what, passed, seen })
}

/** Следующий день после даты — для проверки, что периоды идут подряд. */
function nextDay(day) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

let source
try {
  source = JSON.parse(readFileSync(SOURCE, 'utf8'))
} catch (failure) {
  console.log(`Не прочитать ${SOURCE}: ${failure.message}`)
  console.log('Файл с разбором листа расходов лежит в seed/ и в репозиторий не попадает.')
  process.exit(1)
}

const periods = source.periods ?? []
check('в разборе есть периоды', periods.length > 0, `периодов: ${periods.length}`)

// ─── 1. Слагаемые против столбца «Сумма» ───────────────────────────────────

for (const period of periods) {
  const parts = (period.regular ?? 0) + (period.routine ?? 0) + (period.special ?? 0)
  check(
    `${period.from} — ${period.to}: слагаемые сходятся со столбцом «Сумма»`,
    parts === period.total,
    parts === period.total ? `${period.total}` : `слагаемые дают ${parts}, в таблице ${period.total}`,
  )
}

// ─── 2. «Сумма» против итогового листа ─────────────────────────────────────

for (const period of periods) {
  if (period.crossCheck === null || period.crossCheck === undefined) continue
  check(
    `${period.from} — ${period.to}: сходится с итоговым листом`,
    period.crossCheck === period.total,
    period.crossCheck === period.total ? `${period.total}` : `лист расходов ${period.total}, итоговый ${period.crossCheck}`,
  )
}

// ─── 3. Периоды идут подряд ────────────────────────────────────────────────

for (const [at, period] of periods.entries()) {
  check(
    `${period.from} — ${period.to}: период не вывернут`,
    period.from <= period.to,
    '',
  )
  const previous = periods[at - 1]
  if (!previous) continue
  const expected = nextDay(previous.to)
  check(
    `${period.from}: начинается сразу за прошлым периодом`,
    period.from === expected,
    period.from === expected ? '' : `прошлый кончился ${previous.to}, ждали ${expected}`,
  )
}

// ─── Файл импорта ──────────────────────────────────────────────────────────

/**
 * Два итога на период: обычный — регулярные плюс дефолтные — и особый
 * (Р-14). Без этой разбивки «обычный месяц» на истории был бы завышен
 * на все особые траты.
 *
 * Категории у итогов нет: в таблице её не было вовсе, а частота категорией
 * не становится (Р-05, Р-12).
 */
function entriesOf(period) {
  const made = []
  const usual = (period.regular ?? 0) + (period.routine ?? 0)

  if (usual > 0) {
    made.push({
      kind: 'expense',
      account: source.account,
      amount: usual,
      periodFrom: period.from,
      periodTo: period.to,
      note: period.note ? `Обычные траты таблицы. ${period.note}` : 'Обычные траты таблицы',
    })
  }

  if ((period.special ?? 0) > 0) {
    made.push({
      kind: 'expense',
      account: source.account,
      amount: period.special,
      periodFrom: period.from,
      periodTo: period.to,
      special: true,
      note: 'Особые траты таблицы',
    })
  }

  return made
}

const failed = checks.filter((each) => !each.passed)

for (const each of checks) {
  console.log(`${each.passed ? '  ok' : 'НЕТ '} ${each.what}${each.seen ? ` — ${each.seen}` : ''}`)
}

if (failed.length === 0) {
  const file = {
    format: FORMAT,
    version: 1,
    // Файл обязан быть самодостаточным: он заводит и валюту, и счёт.
    // Счёт ссылается на валюту, а импорт не выдумывает её наугад (Р-13) —
    // без этого раздела перенос в пустую базу не проходит вовсе.
    currencies: [
      {
        code: source.currency,
        name: source.currencyName ?? source.currency,
        decimals: source.currencyDecimals ?? 2,
      },
    ],
    // Счёт истории заводится тем же файлом: выписки на него не грузятся
    // никогда, иначе итоги таблицы столкнутся с выписками тех же месяцев.
    accounts: [{ name: source.account, currency: source.currency, kind: 'savings', ledgerOnly: true }],
    entries: periods.flatMap(entriesOf),
  }

  // Самодостаточность — проверка, а не намерение: файл, который ссылается
  // на то, чего сам не объявил, лёг бы только в ту базу, где это уже есть.
  const declaredCurrencies = new Set(file.currencies.map((each) => each.code))
  const declaredAccounts = new Set(file.accounts.map((each) => each.name))
  if (!file.accounts.every((each) => declaredCurrencies.has(each.currency))) {
    console.log('НЕТ  счёт ссылается на валюту, которой файл не объявляет')
    process.exit(1)
  }
  if (!file.entries.every((each) => declaredAccounts.has(each.account))) {
    console.log('НЕТ  запись ссылается на счёт, которого файл не объявляет')
    process.exit(1)
  }
  writeFileSync(TARGET, `${JSON.stringify(file, null, 2)}\n`, 'utf8')

  const totals = periods.reduce((all, each) => all + each.total, 0)
  console.log(`\nФайл импорта собран: ${TARGET}`)
  console.log(`Периодов ${periods.length}, записей ${file.entries.length}, всего расхода ${totals} ${source.currency}.`)
  for (const gap of source.missing ?? []) {
    console.log(`Не перенесено: ${gap.note} (по итоговому листу — ${gap.crossCheck} ${source.currency}).`)
  }
}

if (problems.length > 0) {
  console.log('\nОшибки:')
  for (const problem of problems) console.log(`  ${problem}`)
}

const bad = failed.length > 0 || problems.length > 0
console.log(
  bad
    ? `\nСверка не прошла: проверок ${checks.length}, не сошлось ${failed.length}`
    : `\nСверка прошла: ${checks.length} проверок, расхождений нет`,
)

process.exit(bad ? 1 : 0)
