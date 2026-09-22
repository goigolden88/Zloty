/**
 * «Какой доход мне нужен» (Р-07, План, Этап 2, п. 1).
 *
 * Второй вопрос приложения, стоящий на той же истории, что и первый:
 * сколько надо зарабатывать, чтобы хватало на обычную жизнь — и чтобы
 * откладывалось столько, сколько задумано.
 *
 * Правила, которые здесь держатся:
 *
 * — **Годовое не считается дважды** (Р-27). Платежи по неежемесячным
 *   шаблонам выносятся из обычного месяца и возвращаются ожидаемой суммой,
 *   делённой на период. Иначе страховка, уплаченная внутри окна, сидела бы
 *   в среднем и прибавлялась сверху;
 * — **вычистить можно не всё.** Итоги прежней таблицы пометок регулярных
 *   не имеют, и сколько в них годовых — неизвестно. Число таких наблюдений
 *   называется, а не замалчивается;
 * — **доход нужен до вычета на сбережения:** цель «откладывать X%» значит,
 *   что расход — это (1 − X) дохода, поэтому нужное делится на (1 − X);
 * — **каждое слагаемое названо:** обычный месяц, доля редких, цель.
 */

import type { Category, Money, Recurring } from '../../app/model.ts'
import { convertTo, type Missing, type MonthData, type Usual } from './month.ts'

/** Шаблоны, категории и всё, что нужно для пересчёта в базовую валюту. */
export type NeedData = MonthData & {
  recurring: readonly Recurring[]
  categories: readonly Category[]
}

/**
 * Действует ли шаблон в этом месяце.
 *
 * Кончившийся шаблон в необходимый доход не идёт: страховка проданной
 * машины денег больше не требует.
 */
export function worksIn(recurring: Recurring, month: string): boolean {
  if (recurring.deleted) return false
  if (month < recurring.from) return false
  return !(recurring.to && month > recurring.to)
}

/**
 * Расходные шаблоны, повторяющиеся реже раза в месяц, — те самые, чью долю
 * надо раскладывать по месяцам.
 *
 * Сторону говорит категория (Р-06): шаблон сам не знает, расход он или
 * доход, а доходный в необходимый доход не идёт вовсе.
 */
export function rareOnes(data: NeedData, month: string): Recurring[] {
  return data.recurring.filter((each) => {
    if (!worksIn(each, month)) return false
    if (!(each.every.months > 1)) return false
    const category = data.categories.find((one) => one.id === each.categoryId && !one.deleted)
    return category?.side === 'expense'
  })
}

/** Их id — по ним платежи выносятся из обычного месяца (Р-27). */
export function rareIds(data: NeedData, month: string): Set<string> {
  return new Set(rareOnes(data, month).map((each) => each.id))
}

/** Доля шаблона в месяц: ожидаемое, делённое на период. */
export function shareOf(recurring: Recurring): Money {
  return {
    amount: Math.round(recurring.expected.amount / recurring.every.months),
    currency: recurring.expected.currency,
  }
}

/** Необходимый доход вместе с тем, из чего он сложился. */
export type Need = {
  /** Сколько нужно в месяц, в базовой валюте. */
  amount: number
  /** Обычный месяц — уже без платежей по редким шаблонам. */
  usual: number
  /** По скольким месяцам и периодам он посчитан. */
  months: number
  periods: number
  /** Доля редких шаблонов в месяц. */
  rare: number
  /** По скольким шаблонам она посчитана. */
  rareCount: number
  /** Цель нормы сбережений, если задана: 0,2 — «откладывать 20%». */
  goal: number | null
  /** Позиции, не вошедшие в итог: нет курса (Р-04). */
  missing: Missing[]
  /**
   * Сколько наблюдений — итоги прежней таблицы, из которых редкие платежи
   * вынести нечем. Ноль редких шаблонов — ноль и здесь: вычищать нечего.
   */
  uncleanedPeriods: number
}

/**
 * Сколько нужно зарабатывать в месяц.
 *
 * Обычного месяца нет — нет и ответа: выдумывать не из чего (Р-07).
 * `usual` приходит уже посчитанным, потому что считается он по тем же
 * наблюдениям, что показывает экран, — и с теми же исключениями.
 */
export function needed(
  usual: Usual | null,
  data: NeedData,
  month: string,
  goal: number | null,
  uncleanedPeriods: number = 0,
): Need | null {
  if (usual === null) return null

  const missing: Missing[] = [...usual.missing]
  let rare = 0
  let rareCount = 0

  // Курс — на конец месяца, о котором спрашивают: у шаблона своей даты нет,
  // а ожидаемая сумма — это то, что он попросит в этом месяце.
  const day = `${month}-01`

  for (const recurring of rareOnes(data, month)) {
    const converted = convertTo(shareOf(recurring), day, data)
    if ('missing' in converted) {
      missing.push(converted.missing)
      continue
    }
    rare += converted.amount
    rareCount += 1
  }

  const spend = usual.monthly + rare
  // Цель «откладывать X%» значит, что расход — это (1 − X) дохода.
  // Единица и выше — не цель, а опечатка: её не пропускают настройки.
  const amount = goal !== null && goal > 0 && goal < 1 ? Math.round(spend / (1 - goal)) : spend

  return {
    amount,
    usual: usual.monthly,
    months: usual.months,
    periods: usual.periods,
    rare,
    rareCount,
    goal,
    missing,
    uncleanedPeriods: rareCount === 0 ? 0 : uncleanedPeriods,
  }
}
