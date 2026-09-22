/**
 * «Месяц»: сколько отложено и хватает ли дохода (Р-07).
 *
 * Главный вопрос приложения, ради которого оно и заводилось. Чистые функции
 * с тестами, без React и без базы: экран только показывает то, что посчитано
 * здесь.
 *
 * Правила, которые здесь держатся:
 *
 * — **Каждое число — с основанием** (Р-07): не «отложено 18%», а «отложено
 *   18% — по 142 операциям». Позиция, которая в итог не вошла, называется,
 *   а не пропадает молча (Р-04).
 * — **Доход не внесён — так и сказано,** а не показан ноль: ноль значил бы
 *   «я ничего не заработал», и это была бы неправда.
 * — **Итог периода по месяцам не дробится** (Р-12, п. 6). Месяц числа из
 *   чужого периода не берёт вовсе; сопоставимость даёт расход в день,
 *   приведённый к `DAYS_IN_MONTH`, — и только там, где сравниваются
 *   промежутки между собой.
 * — **Перевод между своими счетами — не расход и не доход** (Р-12, п. 3):
 *   в итоги он не входит никогда.
 * — **Обычный месяц — без особых трат** (Р-05, Р-07).
 */

import { daysBetween, lastDayOf, monthOf, periodDays } from '../../shared/core/dates.ts'
import type { Currency, Entry, Money, Rate } from '../../app/model.ts'
import { convert } from '../money/rates.ts'

/** Сколько прошлых месяцев берёт «обычный месяц». Число видно в основании и в справке. */
export const USUAL_MONTHS = 6

/**
 * Средняя длина месяца в днях: 365,25 / 12. Ею промежутки приводятся
 * к месяцу, чтобы период в 41 день и месяц в 31 можно было сравнить
 * (Р-12, п. 6).
 */
export const DAYS_IN_MONTH = 30.44

/** Сколько категорий показывать в «вышло за обычное». */
export const OVER_USUAL_SHOWN = 5

/**
 * Сколько прошлых месяцев нужно, чтобы слово «обычное» что-то значило (Р-21).
 *
 * По одному месяцу «обычное» — это тот самый месяц, и отклонение от него
 * равно нулю по определению. Блок молчит и говорит, чего ждёт.
 */
export const OVER_USUAL_MIN = 3

/**
 * Во сколько раз расход должен превысить доход, чтобы доля перестала
 * читаться (Р-23).
 *
 * До этого предела «отложено −40% дохода» — обычная строка. За ним доля
 * уходит в сотни процентов и говорит уже не о месяце, а о том, что доход
 * записан не весь.
 */
export const SAVINGS_TIMES_LIMIT = 2

/** Позиция, которая в итог не вошла: нет курса на дату (Р-04). */
export type Missing = { currency: string; date: string; count: number }

/** Итог вместе с основанием: по скольким записям и чего не хватило. */
export type Sum = {
  /** В базовой валюте. */
  amount: number
  /** По скольким записям посчитано. */
  entries: number
  missing: Missing[]
}

type Converted = { entry: Entry; amount: number } | { entry: Entry; missing: Missing }

/** Всё, что нужно расчёту. Записи — уже без надгробий. */
export type MonthData = {
  entries: readonly Entry[]
  currencies: readonly Currency[]
  rates: readonly Rate[]
  base: string
}

function decimalsOf(currencies: readonly Currency[], code: string): number | null {
  return currencies.find((each) => !each.deleted && each.code === code)?.decimals ?? null
}

/**
 * Сумма записи в базовой валюте на дату записи (Р-04).
 *
 * Курс берётся на дату события, а не сегодняшний: вопрос «сколько это
 * стоило тогда», а не «сколько бы стоило сейчас».
 */
export function convertTo(
  money: Money,
  day: string,
  data: MonthData,
): { amount: number } | { missing: Missing } {
  if (money.currency === data.base) return { amount: money.amount }

  const to = decimalsOf(data.currencies, data.base)
  const from = decimalsOf(data.currencies, money.currency)
  if (to === null || from === null) {
    return { missing: { currency: money.currency, date: day, count: 1 } }
  }

  const result = convert(money, data.base, to, from, data.rates, day)
  if ('missing' in result) {
    return { missing: { currency: result.missing.from, date: result.missing.date, count: 1 } }
  }
  return { amount: result.money.amount }
}

function toBase(entry: Entry, data: MonthData): Converted {
  const day = entry.date ?? entry.period?.to ?? ''
  const result = convertTo(entry.money, day, data)
  return 'missing' in result ? { entry, missing: result.missing } : { entry, amount: result.amount }
}

function sumOf(entries: readonly Entry[], data: MonthData): Sum {
  const missing = new Map<string, Missing>()
  let amount = 0
  let counted = 0

  for (const entry of entries) {
    const result = toBase(entry, data)
    if ('missing' in result) {
      const key = `${result.missing.currency}:${result.missing.date}`
      const was = missing.get(key)
      if (was) was.count += 1
      else missing.set(key, { ...result.missing })
      continue
    }
    amount += result.amount
    counted += 1
  }

  return { amount, entries: counted, missing: [...missing.values()] }
}

// ─── Отбор записей ─────────────────────────────────────────────────────────

/** Операции месяца: по дате. Итоги периодов сюда не входят — они не дробятся. */
function operationsOf(entries: readonly Entry[], month: string): Entry[] {
  return entries.filter((each) => !each.deleted && each.date?.startsWith(`${month}-`))
}

/** Итоги периодов, задевающие месяц. Числами месяца они не становятся. */
function totalsTouching(entries: readonly Entry[], month: string): Entry[] {
  const from = `${month}-01`
  const to = `${month}-31`
  return entries.filter((each) => !each.deleted && each.period && each.period.from <= to && from <= each.period.to)
}

/**
 * Сколько дней месяца накрыты итогами периодов по расходу — объединением,
 * а не суммой: два периода могут задевать один и тот же день (Р-20).
 *
 * Считаются только расходные итоги: по ним и решается, известен ли расход
 * месяца. Итог по доходу расход месяца не прячет.
 */
export function daysCoveredBy(totals: readonly Entry[], month: string): number {
  const days = new Set<string>()

  for (const total of totals) {
    const period = total.period
    if (!period || total.kind !== 'expense') continue
    for (const day of periodDays({ from: period.from, to: period.to })) {
      if (day.startsWith(`${month}-`)) days.add(day)
    }
  }

  return days.size
}

/** Сколько дней в месяце. */
function daysInMonth(month: string): number {
  return daysBetween(`${month}-01`, lastDayOf(month)) + 1
}

/**
 * Владеет ли этими итогами месяц — по большинству его дней (Р-20).
 *
 * Край периода, заходящий в соседний месяц на день-другой, месяц не забирает.
 * Одно правило на два вопроса: считать ли отложенное за месяц (`monthReport`)
 * и становится ли месяц наблюдением для обычного месяца (`observations`).
 * Пока правило жило только в первом, второй брал и неполный месяц операций,
 * и период, который его накрывает, — одни и те же деньги двумя наблюдениями.
 */
export function ownsMonth(totals: readonly Entry[], month: string): boolean {
  return daysCoveredBy(totals, month) * 2 > daysInMonth(month)
}

// ─── Месяц, который ещё идёт ───────────────────────────────────────────────

/** Сколько дней месяца записано, сколько прошло по календарю и сколько всего. */
export type Running = {
  /** Дней месяца, по которые доведены записи. Ими и считается расход. */
  passed: number
  /** Дней месяца, прошедших по календарю. */
  elapsed: number
  /** Всего дней в месяце. */
  total: number
}

/**
 * Насколько месяц прожит — и насколько он записан (Р-22, Р-24).
 *
 * Это разные числа, и в этом всё дело. Календарь говорит, что прошло
 * двадцать два дня; выписки доведены до восемнадцатого. Сравнивать расход
 * надо по записанному сроку, а не по прожитому: иначе четыре дня,
 * которых в базе нет, считаются днями без трат.
 *
 * Null — сравнивать можно целиком: месяц кончился и записан до конца.
 *
 * `today` и `through` приходят аргументами, а не берутся из часов и базы:
 * расчёт остаётся чистой функцией, и тест может встать в любой день.
 */
export function monthShare(month: string, today: string, through?: string | null): Running | null {
  const total = daysInMonth(month)
  const now = monthOf(today)
  const elapsed = month < now ? total : month > now ? 0 : Number(today.slice(8, 10))

  // Не сказали, по какое число доведены записи, — считаем, что до сегодня:
  // это прежнее поведение, и оно остаётся у тестов и у вызовов без базы.
  const recorded = through === undefined || through === null ? elapsed : daysOf(month, through, total)
  const passed = Math.min(recorded, elapsed)

  if (month < now && passed >= total) return null
  return { passed, elapsed, total }
}

/** Сколько дней месяца накрыто датой `through`. */
function daysOf(month: string, through: string, total: number): number {
  if (through < `${month}-01`) return 0
  if (through > lastDayOf(month)) return total
  return Number(through.slice(8, 10))
}

/**
 * Часть суммы, приходящаяся на прошедшие дни месяца (Р-22).
 *
 * Так обычный месяц урезается до того же срока, что уже прожит: сравниваются
 * две известные величины, а не известная с выдуманной. Прогноза здесь нет
 * и быть не должно — квартплата первого числа задрала бы темп, тридцатого
 * занизила бы, а период прежней таблицы потому и делится по дням, что он
 * закончен (Р-12, п. 6).
 */
export function toDate(amount: number, running: Running | null): number {
  if (!running || running.total <= 0) return amount
  return Math.round((amount * running.passed) / running.total)
}

// ─── Отчёт месяца ──────────────────────────────────────────────────────────

export type MonthReport = {
  month: string
  /** Доход месяца. `entries` = 0 — доход не внесён, и это не ноль. */
  income: Sum
  /** Весь расход месяца, вместе с особыми. */
  expense: Sum
  /** Расход без особых — то, из чего складывается обычный месяц. */
  usualExpense: Sum
  /** Особые траты: в расход месяца входят, в обычный месяц — нет. */
  specialExpense: Sum
  /** Доход − расход. Считать нельзя — null, и `savedProblem` говорит почему. */
  saved: number | null
  /** Почему отложенное не посчитано. Null — посчитано. */
  savedProblem: SavedProblem
  /** Отложено / доход. Дохода нет или он нулевой — null. */
  savingsRate: number | null
  /** Переводы месяца: не расход и не доход, но их видно числом. */
  transfers: number
  /** Итоги периодов, задевающие месяц: месяц называет их, а не считает. */
  periodTotals: Entry[]
  /** Сколько дней месяца накрыты итогами по расходу и сколько дней в месяце (Р-20). */
  coveredDays: number
  monthDays: number
  /** Месяц ещё идёт — сколько его дней прошло (Р-22). Null — месяц кончился. */
  running: Running | null
  /**
   * Расход без особых за записанный срок (Р-24) — то единственное, что можно
   * сравнивать с урезанным обычным месяцем. Месяц записан целиком — совпадает
   * с `usualExpense`.
   */
  spanExpense: Sum
}

/**
 * Почему отложенное не посчитано.
 *
 * — `no-income` — доход за месяц не внесён: вычитать не из чего;
 * — `covered` — расход месяца записан итогом за период, а не операциями.
 *   Помесячно он неизвестен, и вычесть его из дохода нельзя (Р-12, п. 6).
 *   Без этого «отложено» показало бы весь доход как отложенный — число
 *   уверенное и неверное.
 */
export type SavedProblem = 'no-income' | 'covered' | null

export function monthReport(
  data: MonthData,
  month: string,
  today?: string,
  through?: string | null,
): MonthReport {
  const operations = operationsOf(data.entries, month)

  const income = sumOf(operations.filter((each) => each.kind === 'income'), data)
  const expenses = operations.filter((each) => each.kind === 'expense')
  const expense = sumOf(expenses, data)
  const usualExpense = sumOf(expenses.filter((each) => !each.special), data)
  const specialExpense = sumOf(expenses.filter((each) => each.special === true), data)

  const periodTotals = totalsTouching(data.entries, month)

  // Расход месяца записан периодом — помесячно он неизвестен, и вычитать
  // его из дохода нельзя. Иначе отложенным окажется весь доход.
  // Доход не внесён — отложенного тоже не существует: ноль здесь означал бы
  // «ничего не отложено», а правда в том, что считать не из чего (Р-07).
  const running = today === undefined ? null : monthShare(month, today, through)
  const monthDays = daysInMonth(month)
  const coveredDays = daysCoveredBy(periodTotals, month)
  // Период «владеет» месяцем по большинству дней (Р-20). Край периода,
  // заходящий в соседний месяц на день-другой, месяц не забирает: иначе
  // первый же месяц с настоящими выписками не отвечает на главный вопрос
  // из-за одного дня.
  const covered = ownsMonth(periodTotals, month)
  const savedProblem: SavedProblem = covered ? 'covered' : income.entries === 0 ? 'no-income' : null

  const saved = savedProblem === null ? income.amount - expense.amount : null
  const savingsRate = saved === null || income.amount === 0 ? null : saved / income.amount

  return {
    month,
    income,
    expense,
    usualExpense,
    specialExpense,
    saved,
    savedProblem,
    savingsRate,
    transfers: operations.filter((each) => each.kind === 'transfer').length,
    periodTotals,
    coveredDays,
    monthDays,
    running,
    spanExpense: sumOf(within(expenses.filter((each) => !each.special), spanEnd(month, running)), data),
  }
}

/**
 * Чем называть норму сбережений (Р-23).
 *
 * — `share` — доля дохода, обычный случай;
 * — `times` — расход больше дохода в разы: доля тут нечитаема, и вместо
 *   процентов говорятся кратность и сумма нехватки;
 * — `none` — считать не из чего; почему именно, говорит `savedProblem`.
 */
export type SavingsRate =
  | { kind: 'share'; share: number }
  | { kind: 'times'; times: number; short: number }
  | { kind: 'none' }

/**
 * Норма сбережений словами, которые можно прочесть.
 *
 * «−1016% дохода» — число честное и с основанием, но нечитаемое: доля
 * от неполного дохода говорит о данных, а не о человеке. Деньги читаются
 * всегда, поэтому за пределом доля уступает место сумме и кратности.
 */
export function savingsRate(report: MonthReport, limit: number = SAVINGS_TIMES_LIMIT): SavingsRate {
  if (report.saved === null || report.income.amount <= 0) return { kind: 'none' }
  const times = report.expense.amount / report.income.amount
  if (times <= limit) return { kind: 'share', share: report.saved / report.income.amount }
  return { kind: 'times', times, short: report.expense.amount - report.income.amount }
}

// ─── Обычный месяц ─────────────────────────────────────────────────────────

/**
 * Одно наблюдение для «обычного месяца»: месяц или промежуток, приведённый
 * к месяцу.
 *
 * Промежутки нужны потому, что история прежней таблицы — это итоги периодов,
 * а не месяцы (Р-12, п. 6): часть длиннее месяца, часть короче. Деление их
 * по дням выдумало бы месяцы, которых не было; расход в день ничего
 * не выдумывает.
 */
export type Observation = {
  kind: 'month' | 'period'
  /** Чем это называть человеку: «2026-08» или «05.01.2026 — 14.02.2026». */
  label: string
  /** Расход, приведённый к месяцу, в базовой валюте. */
  monthly: number
}

/** Обычный месяц: средний расход без особых — и по чему он посчитан (Р-07). */
export type Usual = {
  monthly: number
  months: number
  periods: number
  /** Позиции, не вошедшие в расчёт: нет курса. */
  missing: Missing[]
}

/**
 * Наблюдения за `count` месяцев до `month` — не включая его самого.
 *
 * Месяц без единой записи наблюдением не становится: он означает «я тогда
 * не вносил», а не «я тогда не тратил», и в среднем занизил бы обычный месяц.
 */
export function observations(
  data: MonthData,
  month: string,
  options: { count?: number; without?: ReadonlySet<string> } = {},
): { list: Observation[]; missing: Missing[]; excluded: number; periodsUncleaned: number } {
  const count = options.count ?? USUAL_MONTHS
  // Платежи по неежемесячным шаблонам выносятся из обычного месяца: они
  // вернутся долей в необходимом доходе, и считать их дважды нельзя (Р-27).
  const without = options.without ?? new Set<string>()
  const found: Observation[] = []
  const missing: Missing[] = []
  let excluded = 0

  let cursor = month
  for (let step = 0; step < count; step++) {
    cursor = previousMonth(cursor)
    // Месяцем владеет период — значит его расход записан периодом, а то,
    // что лежит в нём операциями, — часть той же суммы, а не второе
    // наблюдение (Р-20). Считать оба значило бы усреднить неполный месяц
    // выписки вместе с целым периодом, который его же и накрывает.
    if (ownsMonth(totalsTouching(data.entries, cursor), cursor)) continue
    const all = operationsOf(data.entries, cursor).filter((each) => each.kind === 'expense' && !each.special)
    const expenses = all.filter((each) => !(each.recurringId !== undefined && without.has(each.recurringId)))
    excluded += all.length - expenses.length
    if (expenses.length === 0) continue
    const sum = sumOf(expenses, data)
    missing.push(...sum.missing)
    if (sum.entries > 0) found.push({ kind: 'month', label: cursor, monthly: sum.amount })
  }

  // Итоги периодов — тоже наблюдения: на них стоит вся история прежней
  // таблицы. Берутся те, что начались раньше этого месяца и им не владеют
  // (Р-20). Прежнее «кончился раньше первого числа» отбрасывало период,
  // кончающийся ровно первым числом, — то есть самый свежий период истории.
  const totals = data.entries.filter(
    (each) =>
      !each.deleted &&
      each.kind === 'expense' &&
      !each.special &&
      each.period &&
      each.period.from < `${month}-01` &&
      !ownsMonth([each], month),
  )
  for (const total of totals.slice(-count)) {
    const period = total.period
    if (!period) continue
    const result = toBase(total, data)
    if ('missing' in result) continue
    found.push({
      kind: 'period',
      label: `${period.from} — ${period.to}`,
      monthly: perMonth(result.amount, period),
    })
  }

  // Итоги прежней таблицы вычистить нечем: у них нет ни категорий,
  // ни пометок регулярных. Число названо, а не спрятано (Р-27).
  const periodsUncleaned = without.size === 0 ? 0 : found.filter((each) => each.kind === 'period').length

  return { list: found, missing, excluded, periodsUncleaned }
}

/** Расход промежутка, приведённый к месяцу в 30,44 дня (Р-12, п. 6). */
export function perMonth(amount: number, period: { from: string; to: string }): number {
  // Границы включительно: период «5 января — 5 января» — это один день,
  // а не ноль, и делить на ноль тут нечего.
  const days = daysBetween(period.from, period.to) + 1
  if (days <= 0) return amount
  return Math.round((amount / days) * DAYS_IN_MONTH)
}

/** Средний расход по наблюдениям. Наблюдений нет — null: считать не по чему. */
export function usualMonth(list: readonly Observation[], missing: readonly Missing[] = []): Usual | null {
  if (list.length === 0) return null
  const total = list.reduce((all, each) => all + each.monthly, 0)
  return {
    monthly: Math.round(total / list.length),
    months: list.filter((each) => each.kind === 'month').length,
    periods: list.filter((each) => each.kind === 'period').length,
    missing: [...missing],
  }
}

// ─── «Вышло за обычное» ────────────────────────────────────────────────────

/** Категория, в которой этот месяц разошёлся с обычным. */
export type OverUsual = {
  categoryId: string | null
  /** Расход этого месяца в базовой валюте. */
  now: number
  /** Обычный расход по этой категории. */
  usual: number
  /** Насколько больше обычного. Отрицательное — меньше обычного. */
  delta: number
  /** По скольким прошлым месяцам посчитано обычное. */
  months: number
  /** В скольких из них категория вообще встречалась (Р-21). */
  seen: number
}

/** Категория, которой в прошлых месяцах не было вовсе: сравнивать не с чем. */
export type Fresh = {
  categoryId: string | null
  /** Расход этого месяца в базовой валюте. */
  now: number
}

/** «Вышло за обычное» целиком — вместе с тем, почему чего-то нет (Р-21). */
export type OverUsualReport = {
  /** Прошлых месяцев, по которым считается обычное. */
  months: number
  /** Месяц ещё идёт: обычное урезано до прошедших дней (Р-22). */
  running: Running | null
  /** Отклонения по категориям, которые повторяются. */
  over: OverUsual[]
  /** Появившееся впервые. Прячется только то, что и вправду не с чем сравнить. */
  fresh: Fresh[]
  /**
   * Сколько категорий встречались реже половины прошлых месяцев: обычного
   * у них нет, но пропадать молча они не должны (Р-07).
   */
  rare: number
}

/**
 * Что вышло за обычное: категории с наибольшим отклонением от обычного
 * месяца (Р-07).
 *
 * Отвечает на «куда уходит» не списком долей, как таблица, а отклонением:
 * доля категории действия не даёт, а «в этом месяце на транспорт вдвое
 * больше обычного» — даёт.
 *
 * Считается только по месяцам: у итогов периодов категории чаще нет вовсе
 * (Р-12, п. 6), и разложить их по категориям не из чего.
 */
export function overUsual(
  data: MonthData,
  month: string,
  options: { count?: number; shown?: number; least?: number; today?: string; through?: string | null } = {},
): OverUsualReport {
  const count = options.count ?? USUAL_MONTHS
  const shown = options.shown ?? OVER_USUAL_SHOWN
  const least = options.least ?? OVER_USUAL_MIN
  // Месяц ещё идёт — обычное урезается до прожитого срока (Р-22). Иначе
  // двадцатого числа каждая категория оказывается «ниже обычного», и список
  // отклонений говорит только о том, что месяц не кончился.
  const running =
    options.today === undefined ? null : monthShare(month, options.today, options.through)

  const past: string[] = []
  let cursor = month
  for (let step = 0; step < count; step++) {
    cursor = previousMonth(cursor)
    // Тем же правилом, что и наблюдения: месяц, которым владеет период,
    // своих чисел по категориям не имеет — период их не разложен (Р-20).
    if (ownsMonth(totalsTouching(data.entries, cursor), cursor)) continue
    if (operationsOf(data.entries, cursor).some((each) => each.kind === 'expense')) past.push(cursor)
  }

  const empty: OverUsualReport = { months: past.length, running, over: [], fresh: [], rare: 0 }
  // Прошлых месяцев мало — «обычное» по ним равно им самим. Число молчит,
  // а экран говорит, чего ждёт (Р-21, п. 4).
  if (past.length < least) return empty

  // Этот месяц берётся за тот же срок, что и урезанное обычное: иначе
  // сравниваются разные промежутки и каждая категория «выше обычного».
  const now = byCategory(within(operationsOf(data.entries, month), spanEnd(month, running)), data)

  // Не только сумма за прошлые месяцы, но и в скольких месяцах категория
  // вообще встречалась: разовый платёж, размазанный по шести месяцам, даёт
  // верную арифметику без смысла (Р-21, п. 5).
  const before = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const each of past) {
    for (const [categoryId, amount] of byCategory(operationsOf(data.entries, each), data)) {
      before.set(categoryId, (before.get(categoryId) ?? 0) + amount)
      if (amount !== 0) seen.set(categoryId, (seen.get(categoryId) ?? 0) + 1)
    }
  }

  const over: OverUsual[] = []
  const fresh: Fresh[] = []
  let rare = 0

  for (const categoryId of new Set([...now.keys(), ...before.keys()])) {
    const thisMonth = now.get(categoryId) ?? 0
    const months = seen.get(categoryId) ?? 0
    const id = categoryId === NO_CATEGORY ? null : categoryId

    // Категории в прошлом не было вовсе. «Обычно 0» — выдуманное число:
    // обычного у неё нет, и это отдельная строка, а не отклонение.
    if (months === 0) {
      if (thisMonth !== 0) fresh.push({ categoryId: id, now: thisMonth })
      continue
    }

    // Встречалась, но реже половины месяцев — обычного у неё тоже нет.
    // Молча пропасть она не может: её считают числом (Р-07).
    if (months * 2 <= past.length) {
      rare += 1
      continue
    }

    const usual = toDate(Math.round((before.get(categoryId) ?? 0) / past.length), running)
    if (thisMonth === usual) continue
    over.push({ categoryId: id, now: thisMonth, usual, delta: thisMonth - usual, months: past.length, seen: months })
  }

  return {
    months: past.length,
    running,
    over: over.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, shown),
    fresh: fresh.sort((a, b) => b.now - a.now).slice(0, shown),
    rare,
  }
}

/** Ключ для расходов, у которых категории нет: в разбивке они не прячутся. */
const NO_CATEGORY = '—'

/** Обычный расход по категориям: особые не в счёт (Р-05). */
function byCategory(entries: readonly Entry[], data: MonthData): Map<string, number> {
  const sums = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== 'expense' || entry.special) continue
    const result = toBase(entry, data)
    if ('missing' in result) continue
    const key = entry.categoryId ?? NO_CATEGORY
    sums.set(key, (sums.get(key) ?? 0) + result.amount)
  }
  return sums
}

// ─── Месяцы ────────────────────────────────────────────────────────────────

function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const number = Number(month.slice(5, 7))
  if (number > 1) return `${year}-${String(number - 1).padStart(2, '0')}`
  return `${year - 1}-12`
}

/** Столбики по месяцам: расход каждого месяца в базовой валюте (`BarChart` ядра). */
export function monthlyExpenses(data: MonthData, month: string, count: number): { month: string; amount: number }[] {
  const bars: { month: string; amount: number }[] = []
  let cursor = month
  for (let step = 0; step < count; step++) {
    const expenses = operationsOf(data.entries, cursor).filter((each) => each.kind === 'expense')
    bars.unshift({ month: cursor, amount: sumOf(expenses, data).amount })
    cursor = previousMonth(cursor)
  }
  return bars
}

/**
 * Последний день месяца, по который доведены записи (Р-24).
 *
 * Им отрезается и расход этого месяца: сравнивать расход за весь записанный
 * месяц с обычным, урезанным до части месяца, нельзя — стороны меряют разные
 * сроки. Именно так и вышло в первой версии Р-24: «за 1 день месяца —
 * 44 090 ₽» при расходе за весь месяц.
 */
export function spanEnd(month: string, running: Running | null): string | null {
  if (running === null) return null
  return `${month}-${String(running.passed).padStart(2, '0')}`
}

/** Записи месяца не позже записанного дня. `end` пуст — месяц берётся целиком. */
function within(entries: readonly Entry[], end: string | null): Entry[] {
  if (end === null) return [...entries]
  return entries.filter((each) => (each.date ?? '') <= end)
}

/** Сумма в базовой валюте — для показа. */
export function inBase(amount: number, base: string): Money {
  return { amount, currency: base }
}
