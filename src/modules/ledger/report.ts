/**
 * «Что улучшить»: отчёт месяца текстом и вопрос для беседы (Р-07, план
 * Этапа 2, п. 3).
 *
 * Приложение отвечает «сколько». «И что с этим делать» отвечает беседа
 * с Claude — она видит все числа сразу и помнит прошлые разговоры. Claude
 * API отсюда не вызывается: он платный, а продукт тестируется бесплатно
 * (01-Проект, «Границы»). Шов тот же, что у импорта, только в обратную
 * сторону: туда JSON из беседы, отсюда текст в беседу.
 *
 * Правила, которые здесь держатся:
 *
 * — **числа идут с основанием,** как на экране: по скольким записям
 *   посчитано и чего не хватило (Р-07);
 * — **раздел «чего я не знаю» обязателен** (Р-29). Беседа не видит экрана
 *   и не догадается, что расход месяца записан периодом, а категории
 *   не разложены, — без этого она станет объяснять дыры в данных
 *   привычками человека;
 * — **это выгрузка для чтения, а не для переноса:** обратно текст
 *   не загружается, для переноса есть копия в JSON.
 */

import type { Currency } from '../../app/model.ts'
import { formatDate, formatMonth, plural } from '../../shared/core/dates.ts'
import { findCurrency, formatMoney } from '../money/money.ts'
import type { Recorded } from './entries.ts'
import type { CategoryGrowth, Growth, MonthReport, OverUsualReport, Usual } from './month.ts'
import type { Need } from './need.ts'
import type { Due } from './recurring.ts'

/** Всё, что показывает «Месяц», — ровно то же идёт в отчёт. */
export type ReportInput = {
  month: string
  base: string
  currencies: readonly Currency[]
  report: MonthReport
  usual: Usual | null
  need: Need | null
  growth: Growth | null
  categories: { rows: CategoryGrowth[]; months: number }
  over: OverUsualReport
  recorded: Recorded | null
  /** Сколько платежей по редким шаблонам вынесено из обычного месяца (Р-27). */
  excluded: number
  due: readonly Due[]
  names: ReadonlyMap<string, string>
}

/**
 * Вопрос беседе. Стоит в конце текста, а не в начале: сперва числа,
 * потом просьба.
 *
 * Последний пункт — не вежливость. Беседа, которой разрешено сомневаться,
 * дважды находила ошибки в самом приложении, разбирая настоящие числа.
 */
export const REPORT_PROMPT = [
  'Это отчёт моего учёта денег за месяц. Разбери его и скажи:',
  '',
  '1. Что в этом месяце стоит улучшить — конкретно, а не «меньше тратить».',
  '2. Что из названного — разовое, а что похоже на новую привычку.',
  '3. Хватает ли мне дохода и что с этим делать в первую очередь.',
  '4. В чём ты сомневаешься: какие числа выглядят странно и могут говорить',
  '   не о моих тратах, а о том, что данные неполные или разложены неверно.',
  '',
  'Раздел «Чего приложение не знает» читай внимательно: там сказано,',
  'каких данных не хватает. Не объясняй привычками то, что объясняется дырой',
  'в данных.',
].join('\n')

export function monthReportText(input: ReportInput): string {
  const show = (amount: number) =>
    formatMoney({ amount, currency: input.base }, findCurrency(input.currencies, input.base))

  const lines: string[] = [`# Деньги за ${formatMonth(input.month)}`, '']

  lines.push(...completeness(input, show))
  lines.push(...totals(input, show))
  lines.push(...usualPart(input, show))
  lines.push(...needPart(input, show))
  lines.push(...growthPart(input, show))
  lines.push(...overPart(input, show))
  lines.push(...duePart(input, show))
  lines.push(...unknownPart(input, show))

  lines.push('## Вопрос', '', REPORT_PROMPT, '')
  return lines.join('\n')
}

type Show = (amount: number) => string

/** Насколько месяц прожит и насколько записан (Р-22, Р-24, Р-26). */
function completeness(input: ReportInput, _show: Show): string[] {
  const running = input.report.running
  if (running === null) return []

  const out: string[] = []
  if (running.elapsed < running.total) {
    out.push(`Месяц ещё идёт: прошло ${running.elapsed} из ${running.total} ${days(running.total)}.`)
  }
  if (running.passed < running.elapsed && input.recorded) {
    out.push(
      `Выписки доведены по ${formatDate(input.recorded.day)} — по счёту «${input.recorded.account.name}». ` +
        `Расход посчитан по ${running.passed} ${days(running.passed)} месяца, а не по всем прошедшим.`,
    )
  }
  return out.length > 0 ? [...out, ''] : []
}

function days(n: number): string {
  return plural(n, ['дню', 'дням', 'дням'])
}

function totals(input: ReportInput, show: Show): string[] {
  const { report } = input
  const out = ['## Итоги месяца', '']

  out.push(
    report.income.entries === 0
      ? '- Доход: не внесён — это не ноль, а «считать не из чего»'
      : `- Доход: ${show(report.income.amount)} по ${report.income.entries} ${ops(report.income.entries)}`,
  )
  out.push(
    `- Расход: ${show(report.expense.amount)} по ${report.expense.entries} ${ops(report.expense.entries)}` +
      ` — обычный ${show(report.usualExpense.amount)}, особый ${show(report.specialExpense.amount)}`,
  )

  if (report.savedProblem === 'covered') {
    out.push('- Отложено: не посчитано — расход месяца записан итогом за период, а не по дням')
  } else if (report.savedProblem === 'no-income') {
    out.push('- Отложено: не посчитано — доход за месяц не внесён')
  } else {
    const saved = report.saved ?? 0
    const rate =
      report.savingsRate === null
        ? ''
        : report.income.amount > 0 && report.expense.amount > report.income.amount * 2
          ? ` — расход больше дохода в ${Math.round(report.expense.amount / report.income.amount)} раз`
          : ` — ${percent(report.savingsRate)} дохода`
    out.push(`- Отложено: ${show(saved)}${rate}`)
  }

  if (report.transfers > 0) {
    out.push(`- Переводов между своими счетами: ${report.transfers} — они не расход и не доход`)
  }

  return [...out, '']
}

function ops(n: number): string {
  return plural(n, ['операции', 'операциям', 'операциям'])
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

function usualPart(input: ReportInput, show: Show): string[] {
  if (input.usual === null) return ['## Обычный месяц', '', 'Считать не по чему: прошлых наблюдений нет.', '']

  const { usual } = input
  const basis: string[] = []
  if (usual.months > 0) basis.push(`${usual.months} ${plural(usual.months, ['месяцу', 'месяцам', 'месяцам'])}`)
  if (usual.periods > 0) {
    basis.push(`${usual.periods} ${plural(usual.periods, ['периоду', 'периодам', 'периодам'])} прежней таблицы`)
  }

  const out = ['## Обычный месяц', '', `${show(usual.monthly)} — по ${basis.join(' и ')}, без особых трат`]
  if (input.excluded > 0) {
    out.push(
      `Из него вынесено ${input.excluded} ${plural(input.excluded, ['платёж', 'платежа', 'платежей'])}` +
        ' по редким регулярным: они возвращаются долей в нужном доходе.',
    )
  }
  return [...out, '']
}

function needPart(input: ReportInput, show: Show): string[] {
  if (input.need === null) return []
  const { need, report } = input

  const out = ['## Какой доход мне нужен', '', `${show(need.amount)} в месяц`]
  if (need.rareCount > 0) {
    out.push(
      `Из них ${show(need.rare)} — доля ${need.rareCount}` +
        ` ${plural(need.rareCount, ['регулярной', 'регулярных', 'регулярных'])}, приходящих реже раза в месяц.`,
    )
  }
  if (need.goal !== null && need.goal > 0 && need.goal < 1) {
    out.push(`Учтена цель откладывать ${percent(need.goal)}.`)
  }
  if (report.income.entries > 0) {
    const gap = report.income.amount - need.amount
    out.push(gap >= 0 ? `Дохода хватает с запасом в ${show(gap)}.` : `Дохода не хватает на ${show(-gap)}.`)
  }
  return [...out, '']
}

function growthPart(input: ReportInput, show: Show): string[] {
  const out = ['## Рост обычного месяца', '', 'Это рост моих расходов, а не цен: в нём смешаны и цены, и привычки.']

  if (input.growth === null) {
    out.push('Считать не по чему: наблюдений слишком мало.')
  } else {
    const { growth } = input
    const sign = growth.delta > 0 ? '+' : growth.delta < 0 ? '−' : ''
    const share = growth.share === null ? '' : ` (${growth.share > 0 ? '+' : ''}${percent(growth.share)})`
    out.push(
      `${sign}${show(Math.abs(growth.delta))}${share}: позже (${growth.lateLabel}) — ${show(growth.late)} в месяц,` +
        ` раньше (${growth.earlyLabel}) — ${show(growth.early)}.`,
    )
  }

  if (input.categories.rows.length === 0) {
    out.push(
      `По категориям рост не посчитан: месяцев с операциями — ${input.categories.months}.` +
        ' Итоги прежней таблицы по категориям не разложены.',
    )
  } else {
    out.push('', 'По категориям:')
    for (const row of input.categories.rows) {
      const share = row.share === null ? '' : ` (${row.share > 0 ? '+' : ''}${percent(row.share)})`
      out.push(`- ${nameOf(input, row.categoryId)}: было ${show(row.early)}, стало ${show(row.late)}${share}`)
    }
  }

  return [...out, '']
}

function nameOf(input: ReportInput, id: string | null): string {
  if (id === null) return 'Без категории'
  return input.names.get(id) ?? 'категория удалена'
}

function overPart(input: ReportInput, show: Show): string[] {
  const { over } = input
  if (over.over.length === 0 && over.fresh.length === 0) return []

  const out = ['## Вышло за обычное', '']
  for (const row of over.over) {
    const sign = row.delta > 0 ? '+' : '−'
    out.push(
      `- ${nameOf(input, row.categoryId)}: ${sign}${show(Math.abs(row.delta))}` +
        ` — обычно ${show(row.usual)}, встречалась в ${row.seen} из ${row.months} месяцев`,
    )
  }
  for (const row of over.fresh) {
    out.push(`- ${nameOf(input, row.categoryId)}: ${show(row.now)} — раньше такой траты не было`)
  }
  if (over.rare > 0) {
    out.push(
      `Ещё ${over.rare} ${plural(over.rare, ['категория встречалась', 'категории встречались', 'категорий встречались'])}` +
        ' реже чем в половине прошлых месяцев — обычного у них нет.',
    )
  }
  return [...out, '']
}

function duePart(input: ReportInput, show: Show): string[] {
  if (input.due.length === 0) return []

  const out = ['## Регулярные', '']
  for (const one of input.due) {
    const paid = one.entries.length > 0
    out.push(
      `- ${one.recurring.name}: ждали ${show(one.recurring.expected.amount)}, ` +
        (paid ? `внесено ${show(one.paid)}` : 'не внесено'),
    )
  }
  return [...out, '']
}

/**
 * Чего приложение не знает (Р-29).
 *
 * Самый важный раздел отчёта. Беседа экрана не видит, и без него она
 * объяснит дыры в данных привычками человека — уверенно и неверно.
 */
function unknownPart(input: ReportInput, show: Show): string[] {
  const out: string[] = []
  const { report } = input

  for (const total of report.periodTotals) {
    out.push(
      `- ${report.coveredDays} ${plural(report.coveredDays, ['день', 'дня', 'дней'])} месяца из ${report.monthDays}` +
        ` записаны итогом за период: ${show(total.money.amount)} за` +
        ` ${formatDate(total.period?.from ?? '')} — ${formatDate(total.period?.to ?? '')}, по категориям не разложено`,
    )
  }

  const running = report.running
  if (running !== null && running.passed < running.elapsed) {
    out.push(
      `- Расход за последние ${running.elapsed - running.passed}` +
        ` ${plural(running.elapsed - running.passed, ['день', 'дня', 'дней'])} неизвестен: выписки не загружены`,
    )
  }

  if (report.income.entries === 0) out.push('- Доход за месяц не внесён вовсе')

  const missing = [...report.income.missing, ...report.expense.missing]
  for (const each of missing) {
    out.push(`- В итог не вошло ${each.count}: нет курса ${each.currency} на ${formatDate(each.date)}`)
  }

  if (input.need !== null && input.need.uncleanedPeriods > 0) {
    out.push(
      `- ${input.need.uncleanedPeriods} наблюдений обычного месяца — итоги прежней таблицы,` +
        ' и редкие платежи из них вынести нечем: нужный доход может быть завышен',
    )
  }

  if (input.categories.rows.length === 0) {
    out.push('- По категориям расход сравнивать не с чем: месяцев с операциями пока мало')
  }

  if (out.length === 0) return []
  return ['## Чего приложение не знает', '', ...out, '']
}
