import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CHANGES } from '../changes.ts'
import type { Account } from '../app/model.ts'
import { SYNCED_STORES } from '../app/model.ts'
import { baseCurrencyOf, readProfile } from '../modules/ledger/profile.ts'
import { recordedThrough, type Recorded } from '../modules/ledger/entries.ts'
import { needed, rareIds, type Need } from '../modules/ledger/need.ts'
import { dueThisMonth } from '../modules/ledger/recurring.ts'
import { monthReportText } from '../modules/ledger/report.ts'
import { type DebtsData } from '../modules/debts/summary.ts'
import { useDebts } from '../modules/debts/useDebts.ts'
import { debtsForReport } from '../summary/debts-report.ts'
import { ownShares } from '../summary/shares.ts'
import { incomeNotEntered, type RecurringData } from '../modules/ledger/recurring.ts'
import { useLedger } from '../modules/ledger/useLedger.ts'
import { useEntries } from '../modules/ledger/useEntries.ts'
import { useRates } from '../modules/ledger/useRates.ts'
import {
  monthlyExpenses,
  monthReport,
  observations,
  growthByCategory,
  growthOf,
  GROWTH_MIN,
  GROWTH_MONTHS,
  overUsual,
  OVER_USUAL_MIN,
  savingsRate,
  toDate,
  usualMonth,
  USUAL_MONTHS,
  type Missing,
  type MonthData,
  type CategoryGrowth,
  type Growth,
  type MonthReport,
  type Observation,
  type OverUsualReport,
  type Running,
  type SavingsRate,
  type Sum,
} from '../modules/ledger/month.ts'
import { findCurrency, formatMoney } from '../modules/money/money.ts'
import { addMonths, formatDate, formatMonth, MONTHS_SHORT, monthOf, plural, today } from '../shared/core/dates.ts'
import { BarChart, type BarItem } from '../shared/ui/BarChart.tsx'
import { WhatsNew } from '../shared/screens/WhatsNew.tsx'
import { useFirstRun } from '../shared/screens/useFirstRun.ts'
import { useWhatsNew } from '../shared/screens/useWhatsNew.ts'
import { Welcome } from './Welcome.tsx'

/** Сколько месяцев показывают столбики. */
const BARS = 12

/**
 * Главный экран — «Месяц»: сколько отложено и хватает ли дохода (Р-07).
 *
 * Каждое число идёт с основанием: по скольким записям оно посчитано и чего
 * в нём не хватает. Число без основания здесь хуже, чем его отсутствие:
 * ему верят, а проверить нечем.
 *
 * Расчёт — в `modules/ledger/month.ts`, чистыми функциями с тестами. Этот
 * файл только показывает.
 */
export function Month() {
  const base = useFirstRun(SYNCED_STORES)
  const whatsNew = useWhatsNew(base, CHANGES)
  const ledger = useLedger()
  const entries = useEntries()
  const rates = useRates()
  const debts = useDebts()
  const [month, setMonth] = useState(() => monthOf(today()))

  if (whatsNew.show.length > 0) return <WhatsNew changes={whatsNew.show} onDone={whatsNew.dismiss} />

  const busy = ledger.status === 'loading' || entries.status === 'loading' || rates.status === 'loading'
  const profile = readProfile(ledger.data.profile)

  // Валюта итогов: из настроек, а если их нет — единственная заведённая.
  // Приложение доходит до записей и без настроек: валюта, счёт и операции
  // приезжают одним файлом импорта. Упереться после этого в пустой экран
  // значило бы довести человека до данных и не ответить на вопрос.
  const currency = baseCurrencyOf(profile, ledger.data.currencies)

  return (
    <>
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Месяц</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/books" aria-label="Счета и категории">
              ₽
            </Link>
            <Link className="gear" to="/help" aria-label="Справка">
              ?
            </Link>
            <Link className="gear" to="/settings" aria-label="Настройки">
              ⚙
            </Link>
          </div>
        </div>
      </header>

      {base.welcome && <Welcome onDone={base.dismissWelcome} empty={base.empty} />}

      {busy && <p className="muted">Считаю…</p>}

      {!busy && 'pick' in currency && (
        <p className="muted">
          {currency.pick.length === 0
            ? 'Считать пока нечего: ни одной валюты не заведено. Начните со '
            : 'Валют заведено несколько, и надо выбрать, в какой считать итоги. Это '}
          <Link to="/books">{currency.pick.length === 0 ? 'счетов и категорий' : 'настройки учёта'}</Link>
          {currency.pick.length === 0 ? ' — там же заводятся валюты.' : '.'}
        </p>
      )}

      {!busy && 'code' in currency && (
        <>
          {currency.from === 'only' && (
            <p className="basis">
              Итоги считаются в {currency.code} — это единственная заведённая валюта. Станет больше —
              основную выбирают в <Link to="/books">настройках учёта</Link>.
            </p>
          )}
          <Report
            month={month}
            onMonth={setMonth}
            data={{
              entries: entries.all,
              currencies: ledger.data.currencies,
              rates: rates.all,
              base: currency.code,
              // Связанная операция входит в поток долей, а не суммой (Р-31).
              // Считает долю сводка: учёт про комнаты не знает.
              shares: ownShares(entries.all, debts.data).amounts,
            }}
            goal={profile?.savingsGoal ?? null}
            names={new Map(ledger.data.categories.map((each) => [each.id, each.name]))}
            waiting={{
              recurring: ledger.data.recurring,
              categories: ledger.data.categories,
              accounts: ledger.data.accounts,
              entries: entries.all,
            }}
            accounts={ledger.data.accounts}
            debts={debts.data}
          />
        </>
      )}
    </>
  )
}

function Report({
  month,
  onMonth,
  data,
  goal,
  names,
  waiting,
  accounts,
  debts,
}: {
  month: string
  onMonth: (month: string) => void
  data: MonthData
  goal: number | null
  names: Map<string, string>
  waiting: RecurringData
  accounts: readonly Account[]
  debts: DebtsData
}) {
  const now = today()
  // По какое число доведены записи — тем же правилом, каким промпт импорта
  // решает, с какого дня брать выписку (Р-24). Календарь и записи расходятся,
  // и сравнивать надо по записанному.
  const recorded = recordedThrough(accounts)
  const report = monthReport(data, month, now, recorded?.day ?? null)
  // Платежи по неежемесячным шаблонам выносятся из обычного месяца: они
  // вернутся долей в необходимом доходе (Р-27).
  const needData = { ...data, recurring: waiting.recurring, categories: waiting.categories }
  const rare = rareIds(needData, month)
  const seen = observations(data, month, { without: rare })
  const usual = usualMonth(seen.list, seen.missing)
  const need = needed(usual, needData, month, goal, seen.periodsUncleaned)
  // Рост смотрит дальше обычного месяца: ему нужны обе половины окна (Р-28).
  const long = observations(data, month, { count: GROWTH_MONTHS, without: rare })
  const growth = growthOf(long.list)
  const byCategory = growthByCategory(data, month, { without: rare })
  const over = overUsual(data, month, { today: now, through: recorded?.day ?? null })
  const bars = monthlyExpenses(data, month, BARS)

  const show = (amount: number) =>
    formatMoney({ amount, currency: data.base }, findCurrency(data.currencies, data.base))

  return (
    <>
      <div className="row month-row">
        <button type="button" onClick={() => onMonth(addMonths(month, -1))} aria-label="Прошлый месяц">
          ←
        </button>
        <b>{formatMonth(month)}</b>
        <button type="button" onClick={() => onMonth(addMonths(month, 1))} aria-label="Следующий месяц">
          →
        </button>
      </div>

      <RunningNote running={report.running} recorded={recorded} />

      {/* Главный ответ — первым. Всё остальное объясняет его. */}
      <div className="block">
        <h2>Отложено</h2>
        {report.savedProblem === 'covered' ? (
          <p className="error">
            Расход за этот месяц записан итогом за период, а не по дням. Сколько отложено именно в этом
            месяце, посчитать нельзя: помесячно расход неизвестен. Числа периода — ниже.
          </p>
        ) : report.savedProblem === 'no-income' ? (
          <p className="error">
            Доход за этот месяц не внесён — считать не из чего. Это не ноль: ноль значил бы, что вы ничего
            не заработали.
          </p>
        ) : (
          <>
            {/* Сюда попадаем только когда `savedProblem` пуст, а значит
                отложенное посчитано: причина его отсутствия разобрана выше. */}
            <p className="big">{show(report.saved ?? 0)}</p>
            <p className="basis">
              {rateWords(savingsRate(report))} — {basis(report.income, 'доход')},{' '}
              {basis(report.expense, 'расход')}
            </p>
            {goal !== null && report.savingsRate !== null && savingsRate(report).kind === 'share' && (
              <p className="basis">
                {report.savingsRate >= goal
                  ? `цель — ${percent(goal)}, и в этом месяце она взята`
                  : `цель — ${percent(goal)}: до неё не хватает ${show(Math.round(report.income.amount * goal) - (report.saved ?? 0))}`}
              </p>
            )}
          </>
        )}
        <WaitingIncome data={waiting} month={month} running={report.running} show={show} names={names} />
      </div>

      <div className="block">
        <h2>Из чего это вышло</h2>
        <ul className="plain">
          <li className="line">
            <div className="line__main">Доход</div>
            <div>
              {report.income.entries === 0 ? <span className="muted">не внесён</span> : show(report.income.amount)}
            </div>
          </li>
          <li className="line">
            <div className="line__main">
              Расход обычный
              <div className="basis">без особых трат</div>
            </div>
            <div>{spent(report, report.usualExpense.amount, show)}</div>
          </li>
          <li className="line">
            <div className="line__main">
              Расход особый
              <div className="basis">в обычный месяц не идёт</div>
            </div>
            <div>{spent(report, report.specialExpense.amount, show)}</div>
          </li>
        </ul>
        <p className="basis">
          {report.expense.entries === 0 && report.savedProblem === 'covered'
            ? 'расход этого месяца записан периодом, а не операциями'
            : basis(report.expense, 'расход')}
          {report.transfers > 0 &&
            `; переводов между своими счетами — ${report.transfers}, они не расход и не доход`}
        </p>
        <MissingNote list={[...report.income.missing, ...report.expense.missing]} />
        <PeriodsNote report={report} show={show} />
      </div>

      <div className="block">
        <h2>Обычный месяц</h2>
        {usual === null ? (
          <p className="muted">
            Считать не по чему: за прошлые {USUAL_MONTHS}{' '}
            {plural(USUAL_MONTHS, ['месяц', 'месяца', 'месяцев'])} записей нет.
            Обычный месяц появится, когда наберётся хотя бы один прошлый месяц с записями.
          </p>
        ) : (
          <>
            <p className="big">{show(usual.monthly)}</p>
            <p className="basis">{usualBasis(usual.months, usual.periods)}</p>
            <MissingNote list={usual.missing} />
            {report.spanExpense.entries > 0 && <ThisMonth report={report} usual={usual.monthly} show={show} />}
          </>
        )}
      </div>

      <NeedBlock need={need} income={report.income} excluded={seen.excluded} show={show} />

      <GrowthBlock growth={growth} seen={long.list} categories={byCategory} names={names} show={show} />

      <OverUsualBlock report={over} names={names} show={show} />

      <ReportCopy
        text={() =>
          monthReportText({
            month,
            base: data.base,
            currencies: data.currencies,
            report,
            usual,
            need,
            growth,
            categories: byCategory,
            over,
            recorded,
            excluded: seen.excluded,
            due: dueThisMonth(waiting, month),
            names,
            debts: debtsForReport({ month, entries: data.entries, debts, data }),
          })
        }
      />

      <div className="block">
        <h2>Расход по месяцам</h2>
        {/* График, у которого нет ни одного столбика, рисует ось с делением
            в одну копейку — число, которого нет в данных. Пустой график
            не объясняет ничего, а объяснить надо: расход записан итогами
            за период, а они по месяцам не дробятся (Р-12, п. 6). */}
        {bars.some((bar) => bar.amount > 0) ? (
          <>
            <BarChart
              items={bars.map((bar): BarItem => ({
                value: bar.amount > 0 ? bar.amount : null,
                label: MONTHS_SHORT[Number(bar.month.slice(5, 7)) - 1] ?? bar.month,
                title: `${formatMonth(bar.month)}: ${bar.amount > 0 ? show(bar.amount) : 'записей нет'}`,
                muted: bar.amount === 0,
              }))}
              label="Расход по месяцам"
              tickText={show}
              peakText={show}
            />
            <p className="basis">
              итоги периодов в столбики не входят: по месяцам они не дробятся
            </p>
          </>
        ) : (
          <p className="muted">
            Рисовать нечего: за последние {BARS} {plural(BARS, ['месяц', 'месяца', 'месяцев'])} нет ни одной
            операции с датой. Расход, записанный итогами за период, в столбики не входит — по месяцам
            он не дробится.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * Насколько месяц прожит и насколько записан (Р-22, Р-24).
 *
 * Это два разных числа, и пока они расходятся, сравнение с обычным месяцем
 * стоит на записанном сроке, а не на календарном. Молчать об этом нельзя:
 * дни, которых в базе нет, иначе читаются как дни без трат.
 */
function RunningNote({ running, recorded }: { running: Running | null; recorded: Recorded | null }) {
  if (running === null) return null

  const { passed, elapsed, total } = running
  const behind = elapsed - passed

  if (elapsed === 0) return <p className="basis">Месяц ещё не начался — сравнивать пока нечего.</p>

  const lived =
    elapsed < total
      ? `Месяц ещё идёт — прошло ${elapsed} из ${total} ${plural(total, ['дня', 'дней', 'дней'])}.`
      : `Месяц кончился, ${total} ${plural(total, ['день', 'дня', 'дней'])}.`

  if (behind === 0) {
    return <p className="basis">{lived} Сравнения с обычным месяцем ниже урезаны до этого же срока.</p>
  }

  // Счёт называется по имени: без него «доведены по первое» — загадка,
  // а с ним — понятно, какую выписку грузить (Р-24).
  return (
    <p className="error">
      {lived} Но записи доведены только по{' '}
      {recorded === null ? 'ничему' : `${formatDate(recorded.day)} — по счёту «${recorded.account.name}»`}
      {passed === 0
        ? ': за этот месяц их нет вовсе'
        : `: не хватает ${behind} ${plural(behind, ['дня', 'дней', 'дней'])}`}
      . С обычным месяцем сравнивается расход за эти {passed}{' '}
      {plural(passed, ['день', 'дня', 'дней'])}, а не за весь месяц: иначе стороны мерили бы
      разные сроки.
    </p>
  )
}

/**
 * Норма сбережений словами, которые читаются (Р-23).
 *
 * Доля от неполного дохода уходит в сотни процентов и говорит о данных,
 * а не о месяце. Деньги читаются всегда.
 */
function rateWords(rate: SavingsRate): string {
  if (rate.kind === 'none') return 'доход нулевой, доля не считается'
  if (rate.kind === 'share') return `${percent(rate.share)} дохода`
  // Сумму нехватки не повторяем: она и есть «отложено» строкой выше.
  const times = Math.round(rate.times)
  return `расход больше дохода в ${times} ${plural(times, ['раз', 'раза', 'раз'])}`
}

/**
 * Доход, которого ждали и не дождались (Р-23).
 *
 * Не догадка о полноте данных, а факт: шаблон сам сказал, чего ждать.
 * Дня месяца у шаблона нет (Р-06), поэтому в идущем месяце говорится
 * «ещё не отмечена» — платёж может быть впереди.
 */
function WaitingIncome({
  data,
  month,
  running,
  show,
  names,
}: {
  data: RecurringData
  month: string
  running: Running | null
  show: (amount: number) => string
  names: Map<string, string>
}) {
  const waiting = incomeNotEntered(data, month)
  if (waiting.length === 0) return null

  const yet = running !== null ? ' ещё' : ''

  return (
    <p className="basis">
      Доход внесён не весь:{' '}
      {waiting
        .map(
          (due) =>
            `регулярная «${due.recurring.name}» (${names.get(due.recurring.categoryId) ?? 'категория удалена'})` +
            ` за этот месяц${yet} не отмечена — ждали ${show(due.recurring.expected.amount)}`,
        )
        .join('; ')}
      .
    </p>
  )
}

/**
 * Этот месяц против обычного (Р-07), а у месяца, который ещё идёт, —
 * против той его части, что уже прожита (Р-22).
 *
 * Сравнивать неполный месяц с полным нельзя: двадцатого числа любой месяц
 * «меньше обычного», и строка говорит не о тратах, а о календаре.
 */
function ThisMonth({
  report,
  usual,
  show,
}: {
  report: MonthReport
  usual: number
  show: (amount: number) => string
}) {
  const running = report.running
  // За записанный срок, а не за весь месяц: он и сравнивается с урезанным
  // обычным (Р-24). Месяц записан целиком — это одно и то же число.
  const now = report.spanExpense.amount
  const against = toDate(usual, running)
  const word = now > against ? 'больше' : 'меньше'
  const delta = show(Math.abs(now - against))

  if (running === null) {
    return (
      <p className="basis">
        этот месяц — {show(now)}, то есть {word} обычного на {delta}
      </p>
    )
  }
  if (running.passed === 0) return null

  // «За прошедшие 22 дня» было бы неправдой там, где записей всего за 18
  // (Р-24): считается записанный срок, им и называется.
  return (
    <p className="basis">
      за {running.passed} {plural(running.passed, ['день', 'дня', 'дней'])} месяца — {show(now)},
      а обычно за такой же срок — {show(against)}: {word} на {delta}
    </p>
  )
}

/**
 * «Какой доход мне нужен» (Р-07, Р-27) — второй вопрос приложения.
 *
 * Каждое слагаемое названо: обычный месяц, доля редких шаблонов, цель.
 * Из чего вычесть нельзя — тоже названо: итоги прежней таблицы пометок
 * регулярных не имеют.
 */
function NeedBlock({
  need,
  income,
  excluded,
  show,
}: {
  need: Need | null
  income: Sum
  excluded: number
  show: (amount: number) => string
}) {
  if (need === null) return null

  const enough = income.entries > 0 ? income.amount - need.amount : null

  return (
    <div className="block">
      <h2>Какой доход мне нужен</h2>
      <p className="big">{show(need.amount)}</p>

      {/* Редких регулярных нет и цели нет — нужное равно обычному месяцу,
          и повторять его основание слово в слово незачем. Сказать надо
          другое: почему числа совпали и что их разведёт. */}
      {need.amount === need.usual ? (
        <p className="basis">
          это ровно обычный месяц: регулярных, приходящих реже раза в месяц, не заведено
          {(need.goal === null || need.goal === 0) && ', и цель откладывать долю дохода не задана'}
        </p>
      ) : (
        <p className="basis">
          обычный месяц {show(need.usual)}
          {need.rareCount > 0 && (
            <>
              ; плюс {show(need.rare)} в месяц — доля {need.rareCount}{' '}
              {plural(need.rareCount, [
                'регулярной, приходящей',
                'регулярных, приходящих',
                'регулярных, приходящих',
              ])}{' '}
              реже раза в месяц
            </>
          )}
          {need.goal !== null && need.goal > 0 && need.goal < 1 && (
            <>; и цель откладывать {percent(need.goal)}</>
          )}
        </p>
      )}

      {excluded > 0 && (
        <p className="basis">
          из обычного месяца вынесено {excluded}{' '}
          {plural(excluded, ['платёж', 'платежа', 'платежей'])} по редким регулярным — иначе они
          посчитались бы дважды
        </p>
      )}

      {need.uncleanedPeriods > 0 && (
        <p className="error">
          {need.uncleanedPeriods} {plural(need.uncleanedPeriods, ['наблюдение', 'наблюдения', 'наблюдений'])} из
          обычного месяца — итоги прежней таблицы, и вынести редкие платежи из них нечем: пометок
          регулярных у них нет. Если такие платежи там были, нужное число немного завышено.
        </p>
      )}

      <MissingNote list={need.missing} />

      {enough === null ? (
        <p className="basis">доход за этот месяц не внесён — сравнивать не с чем</p>
      ) : (
        <p className="basis">
          доход этого месяца — {show(income.amount)} по {income.entries}{' '}
          {plural(income.entries, ['операции', 'операциям', 'операциям'])}:{' '}
          {enough >= 0 ? `хватает с запасом в ${show(enough)}` : `не хватает ${show(-enough)}`}
        </p>
      )}
    </div>
  )
}

/**
 * «Что улучшить» (Р-07, Р-29): отчёт месяца и вопрос — в буфер, разбор —
 * в беседе с Claude.
 *
 * Claude API отсюда не вызывается: он платный, а продукт тестируется
 * бесплатно. Текст собирается по кнопке, а не при каждой перерисовке:
 * он никому не нужен, пока его не попросили.
 */
function ReportCopy({ text }: { text: () => string }) {
  const [note, setNote] = useState('')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text())
      setNote('Отчёт скопирован — вставьте его в беседу с Claude')
    } catch {
      setNote('Скопировать не вышло: браузер не дал доступ к буферу обмена')
    }
  }

  return (
    <div className="block">
      <h2>Что улучшить</h2>
      <p className="basis">
        Приложение считает числа, а разбирает их беседа с Claude: она видит их все сразу и помнит
        прошлые разговоры. Отчёт вместе с вопросом копируется в буфер — вставьте его в беседу.
      </p>
      <div className="row">
        <button type="button" onClick={() => void copy()}>
          Скопировать отчёт
        </button>
      </div>
      {note && <p className="basis">{note}</p>}
    </div>
  )
}

/**
 * «Рост обычного месяца» (Р-07, Р-28) — он же личная инфляция, названная
 * честно.
 *
 * Не рост цен, а рост своих расходов, где смешаны цены и привычки. Оговорка
 * стоит подзаголовком, а не прячется в справке: число без неё читается как
 * «инфляция у меня такая», и это неправда.
 */
function GrowthBlock({
  growth,
  seen,
  categories,
  names,
  show,
}: {
  growth: Growth | null
  seen: readonly Observation[]
  categories: { rows: CategoryGrowth[]; months: number }
  names: Map<string, string>
  show: (amount: number) => string
}) {

  return (
    <div className="block">
      <h2>Рост обычного месяца</h2>
      <p className="basis">личная инфляция — рост ваших расходов, а не цен: в нём смешаны и цены, и привычки</p>

      {growth === null ? (
        <p className="muted">
          Считать не по чему: наблюдений — {seen.length}, а нужно {GROWTH_MIN}, по два на половину.
          По одному наблюдению с каждой стороны это разница двух месяцев, а не рост.
        </p>
      ) : (
        <>
          <p className="big">
            {growth.delta > 0 ? '+' : growth.delta < 0 ? '−' : ''}
            {show(Math.abs(growth.delta))}
            {growth.share !== null && ` · ${growth.share > 0 ? '+' : ''}${percent(growth.share)}`}
          </p>
          <p className="basis">
            позже ({growth.lateLabel}) — {show(growth.late)} в месяц; раньше ({growth.earlyLabel}) —{' '}
            {show(growth.early)}. По {growth.lateCount} и {growth.earlyCount}{' '}
            {plural(growth.earlyCount, ['наблюдению', 'наблюдениям', 'наблюдениям'])} за последние{' '}
            {GROWTH_MONTHS} {plural(GROWTH_MONTHS, ['месяц', 'месяца', 'месяцев'])}
            {growth.dropped > 0 && '; среднее наблюдение выброшено, чтобы половины были равны'}
          </p>
          {growth.share === null && (
            <p className="basis">доли нет: в ранней половине расход нулевой, делить не на что</p>
          )}
        </>
      )}

      {/* По категориям рост стоит только на месяцах: у итогов прежней
          таблицы категорий нет вовсе (Р-12, п. 6). Поэтому месяцев может
          не хватать даже там, где рост в целом уже посчитан. */}
      <h3>По категориям</h3>
      {categories.rows.length === 0 ? (
        <p className="muted">
          Считать не по чему: месяцев с операциями — {categories.months}, а нужно {GROWTH_MIN}.
          Итоги прежней таблицы сюда не идут: по категориям они не разложены.
        </p>
      ) : (
        <>
          <ul className="plain">
            {categories.rows.map((row) => (
              <li key={row.categoryId ?? 'нет'} className="line">
                <div className="line__main">
                  {row.categoryId === null ? 'Без категории' : (names.get(row.categoryId) ?? 'категория удалена')}
                  <div className="basis">
                    было {show(row.early)} в месяц, стало {show(row.late)}
                  </div>
                </div>
                <div className={row.delta > 0 ? 'error' : 'muted'}>
                  {row.delta > 0 ? '+' : '−'}
                  {show(Math.abs(row.delta))}
                  {row.share !== null && ` · ${row.share > 0 ? '+' : ''}${percent(row.share)}`}
                </div>
              </li>
            ))}
          </ul>
          <p className="basis">
            по {categories.months} {plural(categories.months, ['месяцу', 'месяцам', 'месяцам'])}{' '}
            с операциями; категория, которой нет в одной из половин, сюда не идёт — «появилась»
            и «подорожала» — разные вещи
          </p>
        </>
      )}
    </div>
  )
}

/**
 * «Вышло за обычное» (Р-07) вместе с тем, почему чего-то в нём нет (Р-21).
 *
 * Три случая, и каждый называется словами, а не пустотой:
 * мало прошлых месяцев; категория появилась впервые; категория встречается
 * реже половины месяцев. Пустой блок читался бы как «всё в норме».
 */
function OverUsualBlock({
  report,
  names,
  show,
}: {
  report: OverUsualReport
  names: Map<string, string>
  show: (amount: number) => string
}) {
  const nameOf = (id: string | null) =>
    id === null ? 'Без категории' : (names.get(id) ?? 'категория удалена')

  if (report.months < OVER_USUAL_MIN) {
    return (
      <div className="block">
        <h2>Вышло за обычное</h2>
        <p className="muted">
          {report.months === 0
            ? 'Считать не по чему: прошлых месяцев с операциями нет. Месяц, расход которого записан итогом ' +
              'за период, сюда не идёт — у периода нет категорий, и разложить его не из чего.'
            : `Считать не по чему: прошлых месяцев с операциями — ${report.months}, а нужно ${OVER_USUAL_MIN}. ` +
              'По одному месяцу «обычное» — это тот самый месяц, и отклонение от него всегда нулевое.'}{' '}
          Отклонения появятся, когда наберётся {OVER_USUAL_MIN}{' '}
          {plural(OVER_USUAL_MIN, ['месяц', 'месяца', 'месяцев'])} с операциями.
        </p>
      </div>
    )
  }

  if (report.over.length === 0 && report.fresh.length === 0 && report.rare === 0) return null

  return (
    <div className="block">
      <h2>Вышло за обычное</h2>

      {report.over.length > 0 && (
        <ul className="plain">
          {report.over.map((row) => (
            <li key={row.categoryId ?? 'нет'} className="line">
              <div className="line__main">
                {nameOf(row.categoryId)}
                <div className="basis">
                  обычно {show(row.usual)}
                  {report.running !== null && ' за такой же срок'} — по {row.months}{' '}
                  {plural(row.months, ['месяцу', 'месяцам', 'месяцам'])}, встречалась в {row.seen} из{' '}
                  {row.months}
                </div>
              </div>
              <div className={row.delta > 0 ? 'error' : 'muted'}>
                {row.delta > 0 ? '+' : '−'}
                {show(Math.abs(row.delta))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {report.fresh.length > 0 && (
        <>
          <h3>Новое в этом месяце</h3>
          <ul className="plain">
            {report.fresh.map((row) => (
              <li key={row.categoryId ?? 'нет'} className="line">
                <div className="line__main">
                  {nameOf(row.categoryId)}
                  <div className="basis">
                    раньше такой траты не было — сравнивать не с чем
                  </div>
                </div>
                <div>{show(row.now)}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      {report.rare > 0 && (
        <p className="basis">
          ещё {report.rare}{' '}
          {plural(report.rare, ['категория встречалась', 'категории встречались', 'категорий встречались'])} реже
          чем в половине прошлых {plural(report.months, ['месяца', 'месяцев', 'месяцев'])} — обычного{' '}
          {plural(report.rare, ['у неё', 'у них', 'у них'])} нет
        </p>
      )}
    </div>
  )
}

// ─── Основания ─────────────────────────────────────────────────────────────

/**
 * Расход строкой. Своих операций нет, а месяц покрыт периодом — ноль здесь
 * читался бы как «не тратил», хотя правда в том, что расход записан иначе
 * (Р-07: число без основания хуже, чем его отсутствие).
 */
function spent(report: MonthReport, amount: number, show: (amount: number) => string) {
  if (report.expense.entries === 0 && report.savedProblem === 'covered') {
    return <span className="muted">записан периодом</span>
  }
  return show(amount)
}

/** «по 142 операциям» — число вместе с тем, по чему оно посчитано (Р-07). */
function basis(sum: Sum, what: string): string {
  return `${what} — по ${sum.entries} ${plural(sum.entries, ['операции', 'операциям', 'операциям'])}`
}

function usualBasis(months: number, periods: number): string {
  const parts: string[] = []
  if (months > 0) parts.push(`${months} ${plural(months, ['месяцу', 'месяцам', 'месяцам'])}`)
  if (periods > 0) parts.push(`${periods} ${plural(periods, ['периоду', 'периодам', 'периодам'])} прежней таблицы`)
  return `по ${parts.join(' и ')}, без особых трат`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** Чего не хватило, чтобы сумма вошла в итог. Молчать об этом нельзя (Р-04). */
function MissingNote({ list }: { list: readonly Missing[] }) {
  if (list.length === 0) return null
  const lines = list.map((each) => `${each.currency} на ${formatDate(each.date)}${each.count > 1 ? ` (${each.count})` : ''}`)
  return <p className="error">В итог не вошло: нет курса {lines.join(', ')}.</p>
}

/** Месяц, покрытый чужим периодом, называет период, а не показывает число (Р-12, п. 6). */
function PeriodsNote({ report, show }: { report: ReturnType<typeof monthReport>; show: (amount: number) => string }) {
  if (report.periodTotals.length === 0) return null

  // Сколько именно дней месяца лежит в периодах — то самое основание, без
  // которого «частью покрыт» ничего не говорит: один день это или двадцать
  // (Р-07, Р-20).
  const days = report.coveredDays
  const head =
    days === 0
      ? 'Итоги за период задевают этот месяц, но не его дни — их числа в месяц не входят:'
      : `${days} ${plural(days, ['день', 'дня', 'дней'])} этого месяца из ${report.monthDays} ` +
        `${plural(days, ['записан', 'записаны', 'записаны'])} итогами за период — их числа в месяц ` +
        'не входят, и за эти дни расход здесь не учтён:'

  return (
    <div className="panel">
      <p>{head}</p>
      <ul className="plain">
        {report.periodTotals.map((total) => (
          <li key={total.id} className="muted">
            {show(total.money.amount)} за {formatDate(total.period?.from ?? '')} —{' '}
            {formatDate(total.period?.to ?? '')}
          </li>
        ))}
      </ul>
      <p className="basis">
        Сравнивать такие промежутки с месяцами можно расходом в день — так считается обычный месяц.
      </p>
    </div>
  )
}
